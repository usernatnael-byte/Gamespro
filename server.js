const express = require('express');
const cors = require('cors');
const fs = require('fs');
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
        const adminKey = req.get('X-Admin-Key');
        const configuredSecret = process.env.ADMIN_SECRET;
        if (process.env.REQUIRE_TELEGRAM_AUTH === 'true' && !(configuredSecret && adminKey === configuredSecret)) {
            return res.status(401).json({ status: 'error', message: 'Telegram authentication required.' });
        }
        const fallbackId = String(
            process.env.DEFAULT_ADMIN_FALLBACK_ID ||
            (process.env.ADMIN_ID || '').split(/[,;\s]+/).map(v => v.trim()).find(Boolean) ||
            '7396414604'
        );
        req.telegramUser = { id: Number(fallbackId) || fallbackId, first_name: "Cash Bingo", username: "Cashbingosupport1" };
        req.telegramUserId = fallbackId;
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

function parseAdminIds() {
    const ids = [process.env.ADMIN_ID || '', process.env.ADMIN_IDS || '']
        .join(',')
        .split(/[,;\s]+/)
        .map(v => v.trim())
        .filter(Boolean);
    if (ids.length === 0) ids.push('7396414604');
    return new Set(ids);
}

const ADMIN_IDS = parseAdminIds();

const wallet = new FirestoreWallet(db);
const engine = new GameEngine(wallet, 2);
engine.setAdminIds(ADMIN_IDS);

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

function resolveHtmlFile(...filenames) {
    const dirs = [__dirname, path.join(__dirname, 'public')];
    for (const dir of dirs) {
        for (const name of filenames) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return null;
}

if (fs.existsSync(path.join(__dirname, 'public'))) {
    app.use(express.static(path.join(__dirname, 'public')));
}

app.get(['/', '/index.html'], (req, res) => {
    const file = resolveHtmlFile('index.html', 'Index.html');
    if (!file) return res.status(404).send('index.html not found');
    res.sendFile(file);
});

app.get(['/admin', '/Admin', '/admin.html', '/Admin.html'], (req, res) => {
    const file = resolveHtmlFile('admin.html', 'Admin.html');
    if (!file) return res.status(404).send('admin.html not found');
    res.sendFile(file);
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

function requireAdmin(req, res, next) {
    const uid = String(req.telegramUserId || '');
    if (!ADMIN_IDS.has(uid) || !engine.isAdmin(uid)) {
        return res.status(403).json({ status: 'error', message: 'Admin access required.' });
    }
    next();
}

app.use('/api/admin', requireAdmin);

app.get('/api/admin/me', (req, res) => {
    res.json({
        status: 'success',
        isAdmin: true,
        userId: String(req.telegramUserId),
        adminCount: ADMIN_IDS.size
    });
});

app.get('/api/admin/room', (req, res) => {
    try {
        res.json({
            status: 'success',
            room: engine.get_admin_state(getConnectedCount())
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: 'Could not load live room state.' });
    }
});

app.post('/api/admin/room/control', async (req, res) => {
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

app.get('/api/admin/overview', async (req, res) => {
    try {
        const [usersSnap, depositsSnap, withdrawalsSnap, roundsSnap] = await Promise.all([
            db.collection('users').get(),
            db.collection('deposit_requests').get(),
            db.collection('withdrawal_requests').get(),
            db.collection('rounds').get().catch(() => ({ size: 0, docs: [] }))
        ]);

        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const toMs = (val) => {
            if (typeof val === 'number') return val;
            if (typeof val === 'string' && /^\d+$/.test(val)) return Number(val);
            const parsed = Date.parse(val);
            return Number.isNaN(parsed) ? 0 : parsed;
        };

        let mainBalance = 0;
        let bonusBalance = 0;
        let weeklyWinnings = 0;

        for (const doc of usersSnap.docs) {
            const u = doc.data() || {};
            mainBalance += Number(u.balance || 0);
            bonusBalance += Number(u.bonus || 0);
            if (Array.isArray(u.transactions)) {
                for (const t of u.transactions) {
                    if (['win', 'winnings'].includes(t.type)) {
                        const ts = toMs(t.timestamp || t.created_at);
                        if (ts >= weekAgo) weeklyWinnings += Number(t.amount || 0);
                    }
                }
            }
        }

        let pendingDeposits = 0;
        let weeklyDeposits = 0;
        for (const doc of depositsSnap.docs) {
            const r = doc.data() || {};
            if (r.status === 'pending') pendingDeposits++;
            const ts = toMs(r.created_at || r.created_at_iso);
            if (r.status === 'approved' && ts >= weekAgo) {
                weeklyDeposits += Number(r.amount || 0);
            }
        }

        let pendingWithdrawals = 0;
        let weeklyWithdrawals = 0;
        for (const doc of withdrawalsSnap.docs) {
            const r = doc.data() || {};
            if (r.status === 'pending') pendingWithdrawals++;
            const ts = toMs(r.created_at);
            if (r.status !== 'rejected' && ts >= weekAgo) {
                weeklyWithdrawals += Number(r.amount || 0);
            }
        }

        res.json({
            status: 'success',
            stats: {
                users: usersSnap.size,
                mainBalance,
                bonusBalance,
                pendingDeposits,
                pendingWithdrawals,
                rounds: roundsSnap.size || 0,
                weeklyDeposits,
                weeklyWithdrawals,
                weeklyWinnings
            }
        });
    } catch (e) {
        console.error('Admin overview error:', e);
        res.status(500).json({ status: 'error', message: 'Could not load overview.' });
    }
});

app.get('/api/admin/requests', async (req, res) => {
    try {
        const [depositsSnap, withdrawalsSnap] = await Promise.all([
            db.collection('deposit_requests').get(),
            db.collection('withdrawal_requests').get()
        ]);

        const requests = [];
        for (const doc of depositsSnap.docs) {
            const r = doc.data() || {};
            requests.push({
                id: doc.id,
                type: 'deposit',
                user_id: String(r.user_id || ''),
                amount: Number(r.amount || 0),
                status: r.status || 'pending',
                created_at: Number(r.created_at || Date.parse(r.created_at_iso) || 0),
                reference: r.reference || '',
                receipt_text: r.receipt_text || '',
                receipt_image: r.receipt_image || '',
                photo_file_id: r.photo_file_id || ''
            });
        }

        for (const doc of withdrawalsSnap.docs) {
            const r = doc.data() || {};
            requests.push({
                id: doc.id,
                type: 'withdrawal',
                user_id: String(r.user_id || ''),
                amount: Number(r.amount || 0),
                status: r.status || 'pending',
                created_at: Number(r.created_at || 0),
                payout_name: r.payout_name || '',
                payout_account: r.payout_account || ''
            });
        }

        requests.sort((a, b) => {
            if (a.status === 'pending' && b.status !== 'pending') return -1;
            if (b.status === 'pending' && a.status !== 'pending') return 1;
            return (b.created_at || 0) - (a.created_at || 0);
        });

        res.json({ status: 'success', requests: requests.slice(0, 200) });
    } catch (e) {
        console.error('Admin requests error:', e);
        res.status(500).json({ status: 'error', message: 'Could not load requests.' });
    }
});

app.post('/api/admin/review', async (req, res) => {
    const { id, type, approve } = req.body || {};
    if (!id || !['deposit', 'withdrawal'].includes(type) || typeof approve !== 'boolean') {
        return res.status(400).json({ status: 'error', message: 'Invalid review payload.' });
    }

    const colName = type === 'deposit' ? 'deposit_requests' : 'withdrawal_requests';
    const reqRef = db.collection(colName).doc(String(id));

    try {
        let targetUserId = null;
        let targetAmount = 0;
        let bonusAwarded = 0;

        await db.runTransaction(async (tx) => {
            const reqSnap = await tx.get(reqRef);
            if (!reqSnap.exists) throw new Error('REQUEST_NOT_FOUND');
            const r = reqSnap.data();
            if (r.status !== 'pending') throw new Error('ALREADY_REVIEWED');

            targetUserId = String(r.user_id);
            targetAmount = Number(r.amount || 0);
            const userRef = db.collection('users').doc(targetUserId);
            const userSnap = await tx.get(userRef);
            const u = userSnap.exists ? userSnap.data() : {};
            const txs = Array.isArray(u.transactions) ? u.transactions : [];
            const nowIso = new Date().toISOString();

            let autoBonusCfg = null;
            if (type === 'deposit' && approve) {
                const bonusSnap = await tx.get(db.collection('settings').doc('auto_bonus'));
                if (bonusSnap.exists) autoBonusCfg = bonusSnap.data();
            }

            tx.update(reqRef, {
                status: approve ? 'approved' : 'rejected',
                reviewed_by: String(req.telegramUserId),
                reviewed_at: Date.now()
            });

            if (type === 'deposit') {
                if (approve) {
                    const currentBalance = Number(u.balance || 0);
                    let currentBonus = Number(u.bonus || 0);
                    const totalDeposited = Number(u.total_deposited || 0) + targetAmount;
                    const newTxs = [...txs, {
                        type: 'deposit',
                        wallet: 'main',
                        amount: targetAmount,
                        request_id: String(id),
                        status: 'approved',
                        timestamp: nowIso
                    }];

                    if (autoBonusCfg && autoBonusCfg.enabled && targetAmount >= Number(autoBonusCfg.minDeposit || 0)) {
                        if (autoBonusCfg.type === 'percent') {
                            bonusAwarded = Math.round((targetAmount * Number(autoBonusCfg.value || 0) / 100) * 100) / 100;
                        } else {
                            bonusAwarded = Number(autoBonusCfg.value || 0);
                        }
                        if (bonusAwarded > 0) {
                            currentBonus += bonusAwarded;
                            newTxs.push({
                                type: 'auto_deposit_bonus',
                                wallet: 'bonus',
                                amount: bonusAwarded,
                                request_id: String(id),
                                status: 'approved',
                                timestamp: nowIso
                            });
                        }
                    }

                    const updates = {
                        balance: currentBalance + targetAmount,
                        bonus: currentBonus,
                        has_deposited: true,
                        total_deposited: totalDeposited,
                        transactions: newTxs
                    };
                    if (userSnap.exists) tx.update(userRef, updates);
                    else tx.set(userRef, updates, { merge: true });
                }
            } else {
                // withdrawal
                if (approve) {
                    tx.update(userRef, {
                        transactions: [...txs, {
                            type: 'withdrawal',
                            wallet: 'main',
                            amount: targetAmount,
                            request_id: String(id),
                            status: 'approved',
                            timestamp: nowIso
                        }]
                    });
                } else {
                    const currentBalance = Number(u.balance || 0);
                    tx.update(userRef, {
                        balance: currentBalance + targetAmount,
                        transactions: [...txs, {
                            type: 'refund',
                            wallet: 'main',
                            amount: targetAmount,
                            request_id: String(id),
                            status: 'rejected',
                            description: 'Withdrawal rejected refund',
                            timestamp: nowIso
                        }]
                    });
                }
            }
        });

        if (targetUserId && typeof bot !== 'undefined' && bot?.telegram) {
            const msg = type === 'deposit'
                ? (approve
                    ? `✅ ${targetAmount.toFixed(2)} ETB ዲፖዚትዎ ተፈቅዷል!${bonusAwarded > 0 ? `\n🎁 +${bonusAwarded.toFixed(2)} ETB Auto Bonus ተጨምሯል።` : ''}`
                    : `❌ ${targetAmount.toFixed(2)} ETB ዲፖዚት ጥያቄዎ ውድቅ ተደርጓል።`)
                : (approve
                    ? `✅ ${targetAmount.toFixed(2)} ETB የማውጣት ጥያቄዎ ተፈቅዷል!`
                    : `❌ ${targetAmount.toFixed(2)} ETB የማውጣት ጥያቄዎ ውድቅ ተደርጓል። ገንዘቡ ወደ Main Balance ተመልሷል።`);
            bot.telegram.sendMessage(targetUserId, msg).catch(() => {});
        }

        res.json({ status: 'success', message: 'Request updated.' });
    } catch (e) {
        if (e.message === 'REQUEST_NOT_FOUND') return res.status(404).json({ status: 'error', message: 'Request not found.' });
        if (e.message === 'ALREADY_REVIEWED') return res.status(400).json({ status: 'error', message: 'Request already reviewed.' });
        console.error('Admin review error:', e);
        res.status(500).json({ status: 'error', message: 'Could not review request.' });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const snap = await db.collection('users').get();
        const matches = [];

        for (const doc of snap.docs) {
            const u = doc.data() || {};
            const id = String(doc.id);
            const firstName = String(u.first_name || '');
            const username = String(u.username || '');
            const phone = String(u.phone_number || '');

            if (!q || [id, firstName, username, phone].some(f => f.toLowerCase().includes(q))) {
                matches.push({
                    id,
                    first_name: firstName,
                    username,
                    phone_number: phone,
                    balance: Number(u.balance || 0),
                    bonus: Number(u.bonus || 0),
                    has_deposited: Boolean(u.has_deposited),
                    blocked: Boolean(u.blocked)
                });
            }
        }

        res.json({ status: 'success', users: matches.slice(0, 100) });
    } catch (e) {
        console.error('Admin users search error:', e);
        res.status(500).json({ status: 'error', message: 'Could not search users.' });
    }
});

app.post('/api/admin/user-action', async (req, res) => {
    const { userId, action, amount, walletType } = req.body || {};
    if (!userId || !['block', 'unblock', 'credit', 'debit'].includes(action)) {
        return res.status(400).json({ status: 'error', message: 'Invalid user action.' });
    }

    const userRef = db.collection('users').doc(String(userId));
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(userRef);
            if (!snap.exists) throw new Error('USER_NOT_FOUND');
            const u = snap.data() || {};

            if (action === 'block' || action === 'unblock') {
                tx.update(userRef, { blocked: action === 'block' });
                return;
            }

            const amt = Number(amount);
            if (!Number.isFinite(amt) || amt <= 0) throw new Error('INVALID_AMOUNT');
            const field = walletType === 'bonus' ? 'bonus' : 'balance';
            const current = Number(u[field] || 0);
            if (action === 'debit' && current < amt) throw new Error('INSUFFICIENT_BALANCE');

            const nextVal = action === 'credit' ? current + amt : current - amt;
            const txs = Array.isArray(u.transactions) ? u.transactions : [];
            tx.update(userRef, {
                [field]: nextVal,
                transactions: [...txs, {
                    type: action === 'credit' ? 'bonus' : 'admin_debit',
                    wallet: walletType === 'bonus' ? 'bonus' : 'main',
                    amount: amt,
                    description: `Admin ${action} (${field})`,
                    timestamp: new Date().toISOString()
                }]
            });
        });

        res.json({ status: 'success', message: 'User updated.' });
    } catch (e) {
        if (e.message === 'USER_NOT_FOUND') return res.status(404).json({ status: 'error', message: 'User not found.' });
        if (e.message === 'INVALID_AMOUNT') return res.status(400).json({ status: 'error', message: 'Invalid amount.' });
        if (e.message === 'INSUFFICIENT_BALANCE') return res.status(400).json({ status: 'error', message: 'Insufficient user balance.' });
        console.error('Admin user-action error:', e);
        res.status(500).json({ status: 'error', message: 'User action failed.' });
    }
});

app.get('/api/admin/bot-settings', async (req, res) => {
    try {
        const doc = await db.collection('settings').doc('bot_settings').get();
        const settings = doc.exists ? { ...engine.botSettings, ...doc.data() } : engine.botSettings;
        res.json({ status: 'success', settings });
    } catch (e) {
        res.status(500).json({ status: 'error', message: 'Could not load bot settings.' });
    }
});

app.post('/api/admin/bot-settings', async (req, res) => {
    const body = req.body || {};
    const settings = {
        botCount: Math.min(400, Math.max(0, Math.round(Number(body.botCount ?? 50)))),
        botWinPercent: Math.min(100, Math.max(0, Number(body.botWinPercent ?? 20))),
        botCardsPerUser: Math.min(4, Math.max(1, Math.round(Number(body.botCardsPerUser ?? 2)))),
        restrictDepositedWin: Boolean(body.restrictDepositedWin),
        updated_at: Date.now(),
        updated_by: String(req.telegramUserId)
    };

    try {
        await db.collection('settings').doc('bot_settings').set(settings, { merge: true });
        engine.setBotSettings(settings);
        res.json({ status: 'success', settings });
    } catch (e) {
        console.error('Save bot settings error:', e);
        res.status(500).json({ status: 'error', message: 'Could not save bot settings.' });
    }
});

app.get('/api/admin/promos', async (req, res) => {
    try {
        const [bonusSnap, promosSnap] = await Promise.all([
            db.collection('settings').doc('auto_bonus').get(),
            db.collection('promo_codes').get()
        ]);
        const autoBonus = bonusSnap.exists ? bonusSnap.data() : { enabled: false, type: 'percent', value: 0, minDeposit: 100 };
        const promos = promosSnap.docs.map(doc => ({ code: doc.id, ...doc.data() }));
        promos.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
        res.json({ status: 'success', autoBonus, promos });
    } catch (e) {
        console.error('Load promos error:', e);
        res.status(500).json({ status: 'error', message: 'Could not load promos.' });
    }
});

app.post('/api/admin/autobonus', async (req, res) => {
    const body = req.body || {};
    const autoBonus = {
        enabled: Boolean(body.enabled),
        type: body.type === 'fixed' ? 'fixed' : 'percent',
        value: Math.max(0, Number(body.value || 0)),
        minDeposit: Math.max(0, Number(body.minDeposit || 0)),
        updated_at: Date.now(),
        updated_by: String(req.telegramUserId)
    };
    try {
        await db.collection('settings').doc('auto_bonus').set(autoBonus, { merge: true });
        res.json({ status: 'success', autoBonus });
    } catch (e) {
        console.error('Save auto bonus error:', e);
        res.status(500).json({ status: 'error', message: 'Could not save auto bonus settings.' });
    }
});

app.post('/api/admin/promos/create', async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const type = req.body?.type === 'fixed' ? 'fixed' : 'percent';
    const value = Number(req.body?.value || 0);
    const minDeposit = Math.max(0, Number(req.body?.minDeposit || 0));
    const maxUses = Math.max(1, Math.round(Number(req.body?.maxUses || 100)));

    if (!code || !/^[A-Z0-9_-]{2,40}$/.test(code)) {
        return res.status(400).json({ status: 'error', message: 'Valid alphanumeric promo code required.' });
    }
    if (!Number.isFinite(value) || value <= 0) {
        return res.status(400).json({ status: 'error', message: 'Promo value must be greater than 0.' });
    }

    try {
        const promoRef = db.collection('promo_codes').doc(code);
        const existing = await promoRef.get();
        if (existing.exists) {
            return res.status(400).json({ status: 'error', message: 'ይህ ፕሮሞ ኮድ ቀድሞውኑ አለ!' });
        }
        await promoRef.set({
            code,
            type,
            value,
            minDeposit,
            maxUses,
            usedCount: 0,
            usedBy: [],
            created_at: Date.now(),
            created_by: String(req.telegramUserId)
        });
        res.json({ status: 'success', code });
    } catch (e) {
        console.error('Create promo error:', e);
        res.status(500).json({ status: 'error', message: 'Could not create promo code.' });
    }
});

app.post('/api/admin/promos/delete', async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ status: 'error', message: 'Promo code required.' });
    try {
        await db.collection('promo_codes').doc(code).delete();
        res.json({ status: 'success' });
    } catch (e) {
        console.error('Delete promo error:', e);
        res.status(500).json({ status: 'error', message: 'Could not delete promo code.' });
    }
});

app.post('/api/admin/broadcast', async (req, res) => {
    const { message, audience, buttonText, buttonUrl, imageBase64 } = req.body || {};
    const text = String(message || '').trim();
    const img = String(imageBase64 || '');
    if (!text && !img) {
        return res.status(400).json({ status: 'error', message: 'Message or image is required.' });
    }

    let photoBuffer = null;
    if (img) {
        const m = img.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
        if (!m) return res.status(400).json({ status: 'error', message: 'Image must be JPG, PNG, or WEBP.' });
        photoBuffer = Buffer.from(m[2], 'base64');
        if (photoBuffer.length > 7 * 1024 * 1024) {
            return res.status(400).json({ status: 'error', message: 'Image must be under 7MB.' });
        }
    }

    const extra = {};
    if (buttonText && buttonUrl) {
        extra.reply_markup = { inline_keyboard: [[{ text: String(buttonText).trim(), url: String(buttonUrl).trim() }]] };
    }

    try {
        const snap = await db.collection('users').get();
        const targets = [];
        for (const doc of snap.docs) {
            const u = doc.data() || {};
            if (u.blocked) continue;
            const hasPhone = Boolean(u.phone_number && u.phone_number !== 'Not Provided');
            if (audience === 'verified' && !hasPhone) continue;
            if (audience === 'unverified' && hasPhone) continue;
            targets.push(String(doc.id));
        }

        let sent = 0;
        let failed = 0;
        for (const uid of targets) {
            try {
                if (photoBuffer) {
                    await bot.telegram.sendPhoto(uid, { source: photoBuffer }, { caption: text || undefined, ...extra });
                } else {
                    await bot.telegram.sendMessage(uid, text, extra);
                }
                sent++;
            } catch (_) {
                failed++;
            }
        }

        res.json({ status: 'success', sent, failed, total: targets.length });
    } catch (e) {
        console.error('Broadcast error:', e);
        res.status(500).json({ status: 'error', message: 'Broadcast failed.' });
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
module.exports = { app, engine, wallet, ADMIN_IDS };
