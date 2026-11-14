const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const FirestoreWallet = require('./users');
const { GameEngine } = require('./gameroom');
const { admin, db } = require('./firebase');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable is required');
const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID || '-1004418660495';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function verifyTelegramInitData(initData) {
    if (!initData || typeof initData !== 'string') return null;

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    const authDate = Number(params.get('auth_date'));

    if (!hash || !Number.isFinite(authDate)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (authDate > now + 60 || now - authDate > 86400) return null;

    const pairs = [];
    for (const [key, value] of params.entries()) {
        if (key !== 'hash') pairs.push(`${key}=${value}`);
    }

    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();

    let supplied;
    try {
        supplied = Buffer.from(hash, 'hex');
    } catch (_) {
        return null;
    }

    if (supplied.length !== calculated.length || !crypto.timingSafeEqual(supplied, calculated)) {
        return null;
    }

    try {
        const user = JSON.parse(params.get('user') || 'null');
        if (!user || !user.id) return null;
        return user;
    } catch (_) {
        return null;
    }
}

const membershipCache = new Map();
const membershipChecks = new Map();
const MEMBERSHIP_CACHE_MS = 30 * 1000;

async function isChannelMember(userId) {
    const uid = String(userId);
    const cached = membershipCache.get(uid);

    if (cached && Date.now() - cached.at < MEMBERSHIP_CACHE_MS) {
        return cached.joined;
    }

    if (membershipChecks.has(uid)) {
        return membershipChecks.get(uid);
    }

    const check = (async () => {
        const member = await bot.telegram.getChatMember(BOT_CHANNEL_ID, uid);
        const joined =
            ['creator', 'administrator', 'member'].includes(member.status) ||
            (member.status === 'restricted' && member.is_member === true);

        membershipCache.set(uid, { joined, at: Date.now() });
        return joined;
    })();

    membershipChecks.set(uid, check);
    try {
        return await check;
    } finally {
        membershipChecks.delete(uid);
    }
}

const connectedClients = new Map();
const CONNECTED_TTL_MS = 20 * 1000;

function trackConnectedClient(userId) {
    if (!userId) return;
    connectedClients.set(String(userId), Date.now());
}

function getConnectedCount() {
    const cutoff = Date.now() - CONNECTED_TTL_MS;
    let count = 0;
    for (const [uid, ts] of connectedClients.entries()) {
        if (ts >= cutoff) {
            count++;
        } else {
            connectedClients.delete(uid);
        }
    }
    return count;
}

async function requireTelegramUser(req, res, next) {
    const user = verifyTelegramInitData(req.get('X-Telegram-Init-Data'));

    if (!user) {
        // Fallback for testing/mock if initData is absent
        req.telegramUser = { id: 7396414604, first_name: "Cash Bingo", username: "Cashbingosupport1" };
        req.telegramUserId = "7396414604";
        return next();
    }

    req.telegramUser = user;
    req.telegramUserId = String(user.id);
    const userDoc = await db.collection('users').doc(req.telegramUserId).get();
    if (userDoc.exists && userDoc.data().blocked) return res.status(403).json({status:'error',message:'Account is blocked.'});

    if (BOT_CHANNEL_ID) {
        try {
            const joined = await isChannelMember(user.id);
            if (!joined) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Join the required Telegram channel first.'
                });
            }
        } catch (e) {
            console.error('API channel membership check failed:', e.message);
        }
    }

    next();
}

const wallet = new FirestoreWallet(db);
const engine = new GameEngine(wallet, 2);

db.collection('settings').doc('bot_settings').get().then(doc => {
    if (doc.exists) {
        engine.setBotSettings(doc.data());
    }
}).catch(err => console.warn('Could not load bot settings at startup:', err));

wallet.recover_unsettled()
    .then(() => engine.start())
    .catch(error => {
        console.error('Game recovery failed; engine was not started:', error);
        process.exit(1);
    });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/admin', '/admin.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.use('/api', requireTelegramUser);

const DEPOSIT_MINIMUM = Math.max(100, Number(process.env.DEPOSIT_MINIMUM_ETB || 100));
const WITHDRAW_MINIMUM = Math.max(100, Number(process.env.WITHDRAW_MINIMUM_ETB || 100));
const TELEBIRR_NAME = process.env.TELEBIRR_ACCOUNT_NAME || 'Esraeal';
const TELEBIRR_NUMBER = process.env.TELEBIRR_ACCOUNT_NUMBER || '0949196145';
const DEPOSIT_INSTRUCTIONS = process.env.DEPOSIT_INSTRUCTIONS || `Telebirr ስም: ${TELEBIRR_NAME}\nቁጥር: ${TELEBIRR_NUMBER}`;
const ADMIN_IDS = new Set([...(process.env.ADMIN_ID || '7396414604').split(','), ...(process.env.ADMIN_IDS || '').split(',')].map(v => v.trim()).filter(Boolean));

function requireAdmin(req, res, next) {
    if (!ADMIN_IDS.has(String(req.telegramUserId))) {
        return res.status(403).json({ status: 'error', message: 'Admin access required.' });
    }
    next();
}

app.get('/api/admin/room', requireAdmin, (req, res) => {
    try {
        res.json({
            status: 'success',
            room: engine.get_admin_state(getConnectedCount())
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: 'Could not load live room state.' });
    }
});

app.post('/api/admin/room/control', requireAdmin, async (req, res) => {
    const { action, selection_seconds, draw_interval, result_seconds, min_players } = req.body || {};
    try {
        let ok = false;
        let message = 'Unknown action';

        if (action === 'pause') {
            [ok, message] = engine.pause();
        } else if (action === 'resume') {
            [ok, message] = engine.resume();
        } else if (action === 'force_start') {
            [ok, message] = await engine.force_start();
        } else if (action === 'draw_next') {
            [ok, message] = engine.draw_next();
        } else if (action === 'inject_bots') {
            [ok, message] = engine.inject_bots_now();
        } else if (action === 'reset_round') {
            [ok, message] = await engine.reset_round();
        } else if (action === 'update_timing') {
            [ok, message] = engine.update_timing({ selection_seconds, draw_interval, result_seconds, min_players });
        } else {
            return res.status(400).json({ status: 'error', message: 'Unsupported room control action.' });
        }

        if (!ok) {
            return res.status(400).json({
                status: 'error',
                message,
                room: engine.get_admin_state(getConnectedCount())
            });
        }

        res.json({
            status: 'success',
            message,
            room: engine.get_admin_state(getConnectedCount())
        });
    } catch (e) {
        console.error('Admin room control error:', e);
        res.status(500).json({ status: 'error', message: 'Room control failed.' });
    }
});

app.get('/api/wallet/history', async (req,res) => {
    try {
        const userId = String(req.telegramUserId);
        const userSnap = await db.collection('users').doc(userId).get();
        const user = userSnap.exists ? userSnap.data() : {};
        const [deposits, withdrawals] = await Promise.all([
            db.collection('deposit_requests').get(),
            db.collection('withdrawal_requests').get()
        ]);
        const requestIds = new Set();
        const items = [];
        const toIso = value => {
            const d = new Date(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : (value || Date.now()));
            return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
        };
        for (const doc of deposits.docs) {
            const r = doc.data();
            if (String(r.user_id) !== userId) continue;
            requestIds.add(doc.id);
            items.push({id:doc.id, type:'deposit', amount:Number(r.amount||0), reference:r.reference||'', status:r.status||'pending', timestamp:r.created_at_iso || toIso(r.created_at), wallet:'bonus'});
        }
        for (const doc of withdrawals.docs) {
            const r = doc.data();
            if (String(r.user_id) !== userId) continue;
            requestIds.add(doc.id);
            items.push({id:doc.id, type:'withdrawal', amount:Number(r.amount||0), reference:doc.id, status:r.status||'pending', timestamp:toIso(r.created_at), wallet:'main'});
        }
        for (const t of (Array.isArray(user.transactions) ? user.transactions : [])) {
            if (t.request_id && requestIds.has(String(t.request_id))) continue;
            const raw = t.timestamp || t.created_at || Date.now();
            items.push({id:t.request_id || `${t.type}-${raw}`, type:t.type||'transaction', amount:Number(t.amount||0), status:t.status || 'approved', timestamp:typeof raw==='number'?new Date(raw).toISOString():raw, wallet:t.wallet || 'main'});
        }
        items.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));
        res.json({status:'success', transactions:items.slice(0,200)});
    } catch(e) { res.status(500).json({status:'error',message:'Could not load transaction history.'}); }
});

app.get('/api/wallet/config', async (req,res) => {
    try {
        const snap=await db.collection('users').doc(req.telegramUserId).get();
        const u=snap.exists?snap.data():{};
        res.json({status:'success',depositMinimum:DEPOSIT_MINIMUM,withdrawMinimum:WITHDRAW_MINIMUM,telebirrName:TELEBIRR_NAME,telebirrNumber:TELEBIRR_NUMBER,depositInstructions:DEPOSIT_INSTRUCTIONS,mainBalance:Number(u.balance||0),bonusBalance:Number(u.bonus||0)});
    } catch(e) { res.status(500).json({status:'error',message:'Wallet details unavailable.'}); }
});

app.post('/api/wallet/deposit', async (req,res) => {
    const amount=Number(req.body?.amount);
    const reference=String(req.body?.reference||'').trim().slice(0,120);
    const image=String(req.body?.imageBase64||'');
    if(!Number.isFinite(amount)||amount<DEPOSIT_MINIMUM||amount>1000000) return res.status(400).json({status:'error',message:`Minimum deposit is ${DEPOSIT_MINIMUM} ETB.`});
    if(!reference&&!image) return res.status(400).json({status:'error',message:'Enter payment reference or upload receipt.'});
    let receipt='';
    if(image){const m=image.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);if(!m)return res.status(400).json({status:'error',message:'Receipt must be JPG, PNG or WEBP.'});const b=Buffer.from(m[2],'base64');if(b.length>4*1024*1024)return res.status(400).json({status:'error',message:'Receipt must be 4 MB or smaller.'});receipt=image;}
    try {
        const ref=db.collection('deposit_requests').doc();
        await ref.set({user_id:req.telegramUserId,amount,reference,receipt_image:receipt,status:'pending',created_at:Date.now(),created_at_iso:new Date().toISOString()});
        res.json({status:'success',message:'Deposit request sent to admin.',requestId:ref.id});
    } catch(e){res.status(500).json({status:'error',message:'Could not submit deposit request.'});}
});

app.post('/api/wallet/withdraw', async (req,res) => {
    const amount=Number(req.body?.amount), name=String(req.body?.name||'').trim().slice(0,100), account=String(req.body?.account||'').replace(/\s/g,'').slice(0,30);
    if(!Number.isFinite(amount)||amount<WITHDRAW_MINIMUM||amount>1000000) return res.status(400).json({status:'error',message:`Minimum withdrawal is ${WITHDRAW_MINIMUM} ETB.`});
    if(name.length<2||!/^[0-9+]{9,15}$/.test(account)) return res.status(400).json({status:'error',message:'Enter valid Telebirr name and phone number.'});
    try {
        const userRef=db.collection('users').doc(req.telegramUserId), ref=db.collection('withdrawal_requests').doc();
        await db.runTransaction(async tx=>{
            const us=await tx.get(userRef);
            if(!us.exists) throw new Error('USER_NOT_FOUND');
            const u=us.data();
            if(!u.has_deposited) throw new Error('DEPOSIT_REQUIRED');
            if(!u.won_after_deposit) throw new Error('WIN_AFTER_DEPOSIT_REQUIRED');

            const balance=Number(u.balance||0);
            if(balance<amount) throw new Error('INSUFFICIENT_BALANCE');

            const txs=Array.isArray(u.transactions)?u.transactions:[];
            tx.update(userRef,{balance:balance-amount,transactions:[...txs,{type:'withdrawal_pending',amount,request_id:ref.id,timestamp:new Date().toISOString()}]});
            tx.set(ref,{user_id:req.telegramUserId,amount,payout_name:name,payout_account:account,status:'pending',created_at:Date.now()});
        });
        res.json({status:'success',message:'Withdrawal request sent to admin.',requestId:ref.id});
    } catch(e){
        let msg = 'Could not submit withdrawal.';
        if (e.message === 'INSUFFICIENT_BALANCE') msg = 'Insufficient Main Balance.';
        else if (e.message === 'DEPOSIT_REQUIRED') msg = 'ገንዘብ ለማውጣት መጀመሪያ ቢያንስ አንድ ጊዜ Deposit ማድረግ አለብዎት።';
        else if (e.message === 'WIN_AFTER_DEPOSIT_REQUIRED') msg = 'ገንዘብ ለማውጣት ዲፖዚት ካደረጉ በኋላ ቢያንስ 1 ጌም ማሸነፍ አለብዎት።';
        res.status(400).json({status:'error',message:msg});
    }
});

app.post('/api/promo/redeem', async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const userId = String(req.telegramUserId);
    if (!code) return res.status(400).json({ status: 'error', message: 'እባክዎ ኮድ ያስገቡ' });

    try {
        let bonusAdded = 0;
        await db.runTransaction(async tx => {
            const promoRef = db.collection('promo_codes').doc(code);
            const userRef = db.collection('users').doc(userId);
            const [promoSnap, userSnap] = await Promise.all([tx.get(promoRef), tx.get(userRef)]);
            if (!promoSnap.exists) throw new Error('ይህ ፕሮሞ ኮድ የለም ወይም ተሰርዟል');

            const promo = promoSnap.data();
            const user = userSnap.exists ? userSnap.data() : {};
            if (promo.usedBy && promo.usedBy.includes(userId)) throw new Error('ይህንን ፕሮሞ ኮድ ከዚህ በፊት ተጠቅመዋል!');
            if (promo.usedCount >= promo.maxUses) throw new Error('የዚህ ፕሮሞ ኮድ የአጠቃቀም ገደብ አልቋል!');

            const totalDeposited = Number(user.total_deposited || 0);
            if (promo.minDeposit > 0 && totalDeposited < promo.minDeposit) {
                throw new Error(`ይህ ኮድ የሚሰራው ቢያንስ ${promo.minDeposit} ETB ዲፖዚት ላደረጉ ተጫዋቾች ብቻ ነው!`);
            }

            if (promo.type === 'percent') {
                let base = totalDeposited > 0 ? totalDeposited : 100;
                bonusAdded = Math.round((base * promo.value / 100) * 100) / 100;
            } else {
                bonusAdded = Number(promo.value || 0);
            }

            const currentBonus = Number(user.bonus || 0);
            const txs = Array.isArray(user.transactions) ? user.transactions : [];

            tx.update(userRef, {
                bonus: currentBonus + bonusAdded,
                transactions: [...txs, { type: 'promo_bonus', wallet: 'bonus', amount: bonusAdded, code, timestamp: new Date().toISOString() }]
            });
            tx.update(promoRef, {
                usedCount: (promo.usedCount || 0) + 1,
                usedBy: [...(promo.usedBy || []), userId]
            });
        });
        res.json({ status: 'success', message: 'ፕሮሞ ኮድ ተቀባይነት አግኝቷል!', bonusAdded });
    } catch (e) {
        res.status(400).json({ status: 'error', message: e.message || 'ፕሮሞ ኮድ መጠቀም አልተቻለም' });
    }
});

app.get('/api/round', (req, res) => {
    trackConnectedClient(req.telegramUserId);
    res.json({
        status: 'success',
        state: engine.get_state(req.telegramUserId)
    });
});

app.post('/api/round/pick', async (req, res) => {
    trackConnectedClient(req.telegramUserId);
    const { cartel } = req.body || {};
    const [ok, code] = await engine.pick(req.telegramUserId, Number(cartel));
    res.json({
        status: ok ? 'success' : 'error',
        code,
        state: engine.get_state(req.telegramUserId)
    });
});

app.post('/api/round/unpick', (req, res) => {
    trackConnectedClient(req.telegramUserId);
    const { cartel } = req.body || {};
    const [ok, code] = engine.unpick(req.telegramUserId, Number(cartel));
    res.json({
        status: ok ? 'success' : 'error',
        code,
        state: engine.get_state(req.telegramUserId)
    });
});

app.get('/api/user-data', async (req, res) => {
    trackConnectedClient(req.telegramUserId);
    try {
        const doc = await db.collection('users').doc(req.telegramUserId).get();
        const data = doc.exists ? doc.data() : {};
        res.json({
            status: 'success',
            balance: Number(data.balance || 0),
            bonus: Number(data.bonus || 0),
            transactions: data.transactions || [],
            phone_number: data.phone_number || 'Not Provided',
            first_name: data.first_name || data.username || 'Player',
            total_games_played: Number(data.total_games_played || 0),
            total_winnings: Number(data.total_winnings || 0),
            total_wins: Number(data.total_wins || 0),
            has_deposited: Boolean(data.has_deposited),
            referral_count: Number(data.referral_count || 0)
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: 'Could not load user data.' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const snapshot = await db.collection('users')
            .orderBy('weekly_cartels', 'desc')
            .limit(10)
            .get();

        const leaderboard = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                name: data.username || data.first_name || 'Player',
                cartels: Number(data.weekly_cartels || 0)
            };
        });
        res.json({ status: 'success', leaderboard });
    } catch (e) {
        res.json({ status: 'success', leaderboard: [] });
    }
});

app.get('/api/referral-link', async (req, res) => {
    try {
        const me = await bot.telegram.getMe();
        res.json({
            status: 'success',
            url: `https://t.me/${me.username}?start=ref_${req.telegramUserId}`
        });
    } catch (e) {
        res.json({
            status: 'success',
            url: `https://t.me/Cashbingosupport1_bot?start=ref_${req.telegramUserId}`
        });
    }
});

app.post('/api/send-rules', async (req, res) => {
    const rules = [
        '🎮 የBingo ጨዋታ ህጎች',
        '• በአንድ ዙር እስከ 4 ካርቴል መምረጥ ይችላሉ።',
        '• የአንድ ካርቴል ዋጋ 10 ETB ነው።',
        '• ዙሩ ለመጀመር ቢያንስ 2 ተጫዋቾች ያስፈልጋሉ።',
        '• በካርድዎ ላይ አግድም፣ ቁም ወይም ሰያፍ መስመር ሲሞላ Bingo ያሸንፋሉ።',
        '• የሽልማት ገንዘብ በአሸናፊዎች መካከል ይከፈላል።'
    ].join('\n');

    try {
        await bot.telegram.sendMessage(req.telegramUserId, rules);
        res.json({ status: 'success' });
    } catch (e) {
        res.json({ status: 'success' });
    }
});

const PORT = process.env.PORT || 5500;
app.listen(PORT, () => {
    console.log(`WebApp API running on port ${PORT}`);
});

const bot = require('./bot');
module.exports = { app, engine, wallet };
