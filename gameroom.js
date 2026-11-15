const DEFAULT_TICKET_PRICE = 10;
const DEFAULT_PRIZE_PER_CARTEL = 8;
const MAX_SELECTION = 4;
const CARTEL_COUNT = 500;
const BALLS = 75;

const matrixCache = {};

const ETHIOPIAN_NAMES = [
    "Abenet", "Abel", "Abiy", "Addis", "Afework",
    "Amanuel", "Amha", "Anwar", "Aragaw", "Aschalew",
    "Ashenafi", "Asrat", "Atnafu", "Aklilu", "Axum",
    "Awet", "Ayalew", "Ayenew", "Azmeraw", "Bamlaku",
    "Bante", "Barok", "Bayu", "Befekadu", "Belete",
    "Bereket", "Beresa", "Bete", "Birehanu", "Bizuayehu",
    "Bogale", "Brook", "Chalie", "Daba", "Damte",
    "Daniel", "Dawit", "Debebe", "Delesa", "Demeke",
    "Demissie", "Denekew", "Dereje", "Derso", "Desalegn",
    "Desie", "Desta", "Dinku", "Edom", "Ejigu",
    "Elias", "Endalkachew", "Endeshaw", "Ephrem", "Ermias",
    "Eshetu", "Esubalew", "Eyob", "Ewnetu", "Ezra",
    "Fasil", "Fekadu", "Fenta", "Fikadu", "Fikru",
    "Fitsum", "Genene", "Getachew", "Getahun", "Getu",
    "Gezahagn", "Girma", "Girum", "Gizachew", "Gizaw",
    "Goshu", "Gudeta", "Habtamu", "Hailamariam", "Hailu",
    "Hassen", "Henok", "Indrias", "Kedir", "Kermel",
    "Kidus", "Kinde", "Kirubel", "Kitaw", "Kiyas",
    "Lema", "Lulseged", "Matios", "Mekbeb", "Mekdes",
    "Mekonnen", "Melaku", "Melkamu", "Mengistu", "Menkir",
    "Merga", "Mesfin", "Mikiyas", "Milion", "Mohammed",
    "Moges", "Mola", "Muleta", "Mulu", "Mulugeta",
    "Muluken", "Mulualem", "Nahom", "Natnael", "Nega",
    "Negash", "Negasi", "Obse", "Paulos", "Qana",
    "Reta", "Robel", "Salomon", "Samuel", "Seife",
    "Semere", "Seyoum", "Shiferaw", "Sileshi", "Simachew",
    "Sisay", "Solomon", "Tadesse", "Tamene", "Tamrat",
    "Tariku", "Tatek", "Tazebew", "Tefera", "Tekalign",
    "Tekle", "Teklemariam", "Temesgen", "Tesfahun", "Tesfaye",
    "Teshome", "Tewodros", "Tilahun", "Tizazu", "Tolosa",
    "Tsegaye", "Tsegaw", "Waktola", "Wondimagegn", "Wondossen",
    "Workineh", "Worku", "Yadesa", "Yalew", "Yared",
    "Yeneneh", "Yeshitla", "Yidnekachew", "Yigzaw", "Yilikal",
    "Yilma", "Yimam", "Yirdaw", "Yitagesu", "Yitbarek",
    "Yohannes", "Yonatan", "Yonas", "Yosef", "Zafu",
    "Zekarias", "Zelalem", "Zeleke", "Zewde", "Zewdu",
    "Zinabu", "Zurayesh", "Anteneh", "Asmamaw", "Banchiamlak",
    "Birtukan", "Chemeda", "Damtew", "Demelash", "Ammanuel",
    "Biniam", "Getachew", "Zemnaw1", "Bethelhem",
    "Kalkidan", "Elsabet", "Haymanot", "Hanna", "Rahel",
    "Mimi", "Saron", "Mahi", "Lidia", "Ruth",
    "Meron", "Eden", "Blen", "Tsgered", "Freh"
];

function seededRandom(seed) {
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

function generateMatrix(ticketId) {
    if (matrixCache[ticketId]) return matrixCache[ticketId];
    let seed = ticketId * 1573;
    let matrix = [];
    for (let col = 0; col < 5; col++) {
        let numbers = [];
        let low = col * 15 + 1;
        while (numbers.length < 5) {
            let value = low + Math.floor(seededRandom(seed) * 15);
            seed++;
            if (!numbers.includes(value)) numbers.push(value);
        }
        matrix.push(numbers);
    }
    matrixCache[ticketId] = matrix;
    return matrix;
}

function checkBingo(m, drawnSet) {
    for (let r = 0; r < 5; r++) {
        if ([0, 1, 2, 3, 4].every(c => (r === 2 && c === 2) || drawnSet.has(m[c][r]))) return true;
    }
    for (let c = 0; c < 5; c++) {
        if ([0, 1, 2, 3, 4].every(r => (r === 2 && c === 2) || drawnSet.has(m[c][r]))) return true;
    }
    if ([0, 1, 2, 3, 4].every(i => i === 2 || drawnSet.has(m[i][i]))) return true;
    if ([0, 1, 2, 3, 4].every(i => i === 2 || drawnSet.has(m[4 - i][i]))) return true;
    return false;
}

class GameEngine {
    constructor(wallet, min_players = 2, selection_seconds = 30, draw_interval = 3.0, result_seconds = 10) {
        this.wallet = wallet;
        this.min_players = Math.max(1, min_players);
        this.selection_seconds = selection_seconds;
        this.draw_interval = draw_interval;
        this.result_seconds = result_seconds;
        this.first_draw_delay = 3.0;

        this.ticket_price = DEFAULT_TICKET_PRICE;
        this.prize_per_cartel = DEFAULT_PRIZE_PER_CARTEL;
        this.max_selection = MAX_SELECTION;

        this._seq = 0;
        this._threadRunning = false;
        this.paused = false;
        this._pausedAt = null;
        this.on_round_result = null;
        this._stateListeners = new Set();
        this._balanceCache = new Map();
        this._BALANCE_CACHE_MS = 4000;

        this.adminIds = new Set(
            [process.env.ADMIN_ID || '', process.env.ADMIN_IDS || '']
                .join(',')
                .split(/[,;\s]+/)
                .map(v => v.trim())
                .filter(Boolean)
        );
        if (this.adminIds.size === 0) this.adminIds.add('7396414604');

        this.botSettings = {
            botCount: 20,
            botWinPercent: 20,
            botCardsPerUser: 2,
            restrictDepositedWin: true
        };

        this._newRound();
    }

    onChange(listener) {
        if (typeof listener !== 'function') return () => {};
        this._stateListeners.add(listener);
        return () => this._stateListeners.delete(listener);
    }

    _bumpSeq() {
        this._seq++;
        for (const fn of this._stateListeners) {
            try { fn(this); } catch (_) {}
        }
    }

    setAdminIds(adminIds) {
        if (!adminIds) return;
        const list = Array.isArray(adminIds) || adminIds instanceof Set
            ? Array.from(adminIds)
            : String(adminIds).split(/[,;\s]+/);
        const cleaned = list.map(v => String(v).trim()).filter(Boolean);
        if (cleaned.length > 0) {
            this.adminIds = new Set(cleaned);
        }
    }

    isAdmin(uid) {
        return this.adminIds.has(String(uid || '').trim());
    }

    setBotSettings(settings) {
        if (settings) {
            this.botSettings = { ...this.botSettings, ...settings };
            this._bumpSeq();
        }
    }

    invalidateBalanceCache(uid) {
        if (uid == null) {
            this._balanceCache.clear();
        } else {
            this._balanceCache.delete(String(uid));
        }
    }

    async _getFastBalance(uid) {
        const key = String(uid);
        const cached = this._balanceCache.get(key);
        if (cached && Date.now() - cached.at < this._BALANCE_CACHE_MS) {
            return cached.balance;
        }
        const balance = await this.wallet.get_balance(key);
        this._balanceCache.set(key, { balance: Number(balance || 0), at: Date.now() });
        return balance;
    }

    start() {
        this._threadRunning = true;
        this._runLoop();
        console.log(`🎰 Game engine started (min players: ${this.min_players})`);
    }

    stop() {
        this._threadRunning = false;
    }

    pause() {
        if (this.paused) return [true, 'ሩሙ ቀድሞውኑ ቆሟል'];
        this.paused = true;
        this._pausedAt = Date.now() / 1000;
        this._bumpSeq();
        return [true, 'ጨዋታው ለጊዜው ቆሟል (Paused)'];
    }

    resume() {
        if (!this.paused) return [true, 'ጨዋታው በመካሄድ ላይ ነው'];
        const now = Date.now() / 1000;
        const delta = this._pausedAt ? Math.max(0, now - this._pausedAt) : 0;
        if (this.phase_ends_at != null) this.phase_ends_at += delta;
        if (this.next_draw_at != null) this.next_draw_at += delta;
        this.paused = false;
        this._pausedAt = null;
        this._bumpSeq();
        return [true, 'ጨዋታው ቀጥሏል (Resumed)'];
    }

    async force_start() {
        if (this.phase !== 'selection') {
            return [false, 'Force start የሚሰራው በSelection ጊዜ ብቻ ነው'];
        }
        if (Object.keys(this.cartels).length === 0) {
            return [false, 'ቢያንስ 1 ካርቴል መመረጥ አለበት'];
        }
        this.paused = false;
        this._pausedAt = null;
        this.phase = 'locking';
        this._bumpSeq();
        await this._do_lock(this.cartels);
        return [true, 'ጨዋታው ወዲያውኑ ተጀምሯል!'];
    }

    draw_next() {
        if (this.phase !== 'drawing') {
            return [false, 'ቁጥር ማውጣት የሚቻለው በDrawing ጊዜ ብቻ ነው'];
        }
        const now = Date.now() / 1000;
        this._draw_one(now);
        if (this.paused) {
            this._pausedAt = now;
        }
        return [true, `ቁጥር ${this.drawn[this.drawn.length - 1] ?? ''} ወጥቷል!`];
    }

    call_number(num) {
        const target = Number(num);
        if (this.phase !== 'drawing') {
            return [false, 'ቁጥር መጥራት የሚቻለው በDrawing ጊዜ ብቻ ነው'];
        }
        if (!Number.isInteger(target) || target < 1 || target > BALLS) {
            return [false, 'ቁጥሩ ከ1 እስከ 75 መሆን አለበት'];
        }
        if (this.drawn.includes(target)) {
            return [false, `ቁጥር ${target} ቀድሞውኑ ወጥቷል`];
        }
        const idx = this.drawn.length;
        const pos = this.draw_order.indexOf(target, idx);
        if (pos !== -1) {
            [this.draw_order[idx], this.draw_order[pos]] = [this.draw_order[pos], this.draw_order[idx]];
        }
        const now = Date.now() / 1000;
        this._draw_one(now, true);
        if (this.paused) this._pausedAt = now;
        return [true, `ቁጥር ${target} በቀጥታ ተጠርቷል!`];
    }

    inject_bots_now() {
        if (this.phase !== 'selection') {
            return [false, 'ቦቶችን ማስገባት የሚቻለው በSelection ጊዜ ብቻ ነው'];
        }
        if (!this._botsInjected) {
            this._initBotsQueue();
            this._botsInjected = true;
        }
        const available = [];
        for (let i = 1; i <= CARTEL_COUNT; i++) {
            if (!this.cartels[i]) available.push(i);
        }
        let added = 0;
        while (this.botInjectIndex < this.botQueue.length && available.length > 0) {
            const botId = this.botQueue[this.botInjectIndex++];
            const botExistingCount = Object.values(this.cartels).filter(u => u === botId).length;
            if (botExistingCount >= this.max_selection) continue;
            const randIdx = Math.floor(Math.random() * available.length);
            const chosenCartel = available[randIdx];
            available[randIdx] = available[available.length - 1];
            available.pop();
            this.cartels[chosenCartel] = botId;
            added++;
        }
        if (added > 0) this._bumpSeq();
        return [true, `${added} የቦት ካርቴሎች ገብተዋል`];
    }

    clear_bots() {
        if (this.phase !== 'selection') {
            return [false, 'ቦቶችን ማጽዳት የሚቻለው በSelection ጊዜ ብቻ ነው'];
        }
        let removed = 0;
        for (const [c, uid] of Object.entries(this.cartels)) {
            if (String(uid).startsWith('bot_')) {
                delete this.cartels[c];
                removed++;
            }
        }
        this.botQueue = [];
        this.botInjectIndex = 0;
        this._botsInjected = true;
        if (removed > 0) this._bumpSeq();
        return [true, `${removed} የቦት ካርቴሎች ተነስተዋል`];
    }

    remove_cartel(cartel) {
        const c = Number(cartel);
        if (this.phase !== 'selection') {
            return [false, 'ካርቴል ማንሳት የሚቻለው በSelection ጊዜ ብቻ ነው'];
        }
        if (!this.cartels[c]) {
            return [false, `ካርቴል #${c} አልተያዘም`];
        }
        delete this.cartels[c];
        this._bumpSeq();
        return [true, `ካርቴል #${c} ተነስቷል`];
    }

    async reset_round() {
        const rid = this.round_id;
        if (['locking', 'drawing', 'settling'].includes(this.phase)) {
            const realPaidUids = [...new Set(
                Object.values(this.cartels).filter(u => !String(u).startsWith('bot_'))
            )];
            if (realPaidUids.length > 0) {
                await this.wallet.cancel_round(rid, realPaidUids);
            }
        }
        this.paused = false;
        this._pausedAt = null;
        this._newRound();
        return [true, 'ዙሩ ተሰርዞ አዲስ ዙር ተጀምሯል!'];
    }

    update_timing({ selection_seconds, draw_interval, result_seconds, min_players, ticket_price, prize_per_cartel } = {}) {
        if (Number.isFinite(Number(selection_seconds))) {
            this.selection_seconds = Math.min(300, Math.max(5, Number(selection_seconds)));
        }
        if (Number.isFinite(Number(draw_interval))) {
            this.draw_interval = Math.min(30, Math.max(0.5, Number(draw_interval)));
        }
        if (Number.isFinite(Number(result_seconds))) {
            this.result_seconds = Math.min(60, Math.max(3, Number(result_seconds)));
        }
        if (Number.isFinite(Number(min_players))) {
            this.min_players = Math.min(50, Math.max(1, Math.round(Number(min_players))));
        }
        if (Number.isFinite(Number(ticket_price)) && Number(ticket_price) >= 1) {
            this.ticket_price = Math.min(1000, Math.max(1, Number(ticket_price)));
        }
        if (Number.isFinite(Number(prize_per_cartel)) && Number(prize_per_cartel) >= 1) {
            this.prize_per_cartel = Math.min(1000, Math.max(1, Number(prize_per_cartel)));
        }
        this._bumpSeq();
        return [true, 'የጨዋታ ሰዓት እና ዋጋ ሴቲንግ ተዘምኗል'];
    }

    async _runLoop() {
        while (this._threadRunning) {
            try {
                await this._tick();
            } catch (e) {
                console.error('Engine tick error:', e);
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    _newRound() {
        let now = Date.now() / 1000;
        this.round_id = `r${Math.floor(now * 1000)}`;
        this.phase = 'selection';
        this.phase_ends_at = now + this.selection_seconds;
        this.cartels = {};
        this.botProfiles = {};
        this.restrictedUsers = new Set();
        this.draw_order = [];
        this.drawn = [];
        this.next_draw_at = null;
        this.winners = [];
        this.no_winner = false;
        this._pending = null;
        this._botsInjected = false;
        this.botQueue = [];
        this.botInjectIndex = 0;
        this._bumpSeq();
    }

    async pick(uid, cartel) {
        uid = String(uid);
        if (typeof cartel !== 'number' || cartel < 1 || cartel > CARTEL_COUNT) return [false, 'invalid'];
        if (this.phase !== 'selection') return [false, 'phase'];
        if (this.cartels[cartel] === uid) return [true, 'ok'];
        if (this.cartels[cartel]) return [false, 'taken'];

        let myCount = Object.values(this.cartels).filter(u => u === uid).length;
        if (myCount >= this.max_selection) return [false, 'full'];

        try {
            let balance = await this._getFastBalance(uid);
            if (balance < (myCount + 1) * this.ticket_price) return [false, 'balance'];
        } catch (e) {
            return [false, 'error'];
        }

        if (this.phase !== 'selection') return [false, 'phase'];
        if (this.cartels[cartel]) return [false, 'taken'];
        this.cartels[cartel] = uid;
        this._bumpSeq();
        return [true, 'ok'];
    }

    unpick(uid, cartel) {
        uid = String(uid);
        if (this.phase !== 'selection') return [false, 'phase'];
        if (this.cartels[cartel] === uid) {
            delete this.cartels[cartel];
            this._bumpSeq();
        }
        return [true, 'ok'];
    }

    get_state(uid) {
        uid = String(uid);
        let mine = Object.keys(this.cartels).filter(c => this.cartels[c] === uid).map(Number);
        let winners = [];
        if (this.phase === 'result') {
            winners = this.winners.map(w => ({
                name: w.name || 'Player',
                cartel: w.cartel,
                prize: w.prize,
                mine: w.uid === uid
            }));
        }
        const uniquePlayers = new Set(Object.values(this.cartels));
        return {
            round_id: this.round_id,
            seq: this._seq,
            phase: this.phase,
            paused: this.paused,
            server_time: this.paused && this._pausedAt ? this._pausedAt : Date.now() / 1000,
            phase_ends_at: ['selection', 'result'].includes(this.phase) ? this.phase_ends_at : null,
            selection_seconds: this.selection_seconds,
            result_seconds: this.result_seconds,
            min_players: this.min_players,
            ticket_price: this.ticket_price,
            players: uniquePlayers.size,
            taken: Object.keys(this.cartels).map(Number),
            my_cartels: mine,
            pool: Object.keys(this.cartels).length * this.prize_per_cartel,
            drawn: this.drawn,
            winners: winners,
            no_winner: this.phase === 'result' ? this.no_winner : false,
            is_admin: this.isAdmin(uid)
        };
    }

    get_admin_state(connectedCount = 0) {
        const now = this.paused && this._pausedAt ? this._pausedAt : Date.now() / 1000;
        const entries = Object.entries(this.cartels);
        let botCartels = 0;
        let realCartels = 0;
        const botSet = new Set();
        const realMap = new Map();

        for (const [cartelStr, uid] of entries) {
            const cNum = Number(cartelStr);
            if (String(uid).startsWith('bot_')) {
                botCartels++;
                botSet.add(uid);
            } else {
                realCartels++;
                if (!realMap.has(uid)) realMap.set(uid, []);
                realMap.get(uid).push(cNum);
            }
        }

        let secondsLeft = 0;
        if (this.phase === 'selection' || this.phase === 'result') {
            secondsLeft = this.phase_ends_at ? Math.max(0, Math.ceil(this.phase_ends_at - now)) : 0;
        } else if (this.phase === 'drawing' && this.next_draw_at) {
            secondsLeft = Math.max(0, Math.ceil(this.next_draw_at - now));
        }

        const phaseMap = {
            selection: 'waiting / selection',
            locking: 'locking',
            drawing: 'playing',
            settling: 'settling',
            result: 'result'
        };

        return {
            round_id: this.round_id,
            seq: this._seq,
            phase: this.phase,
            status_text: this.paused ? `PLAY — paused (${this.phase})` : `PLAY — ${phaseMap[this.phase] || this.phase}`,
            paused: this.paused,
            updated_at: Date.now(),
            total_sold: entries.length,
            max_cartels: CARTEL_COUNT,
            bot_cartels: botCartels,
            bots_count: botSet.size,
            real_cartels: realCartels,
            real_players_count: realMap.size,
            connected_count: connectedCount,
            pool: entries.length * this.prize_per_cartel,
            numbers_called: this.drawn.length,
            total_balls: BALLS,
            last_number: this.drawn.length > 0 ? this.drawn[this.drawn.length - 1] : null,
            seconds_left: secondsLeft,
            drawn: this.drawn.slice(),
            winners: this.winners.slice(),
            no_winner: this.phase === 'result' ? this.no_winner : false,
            real_players: Array.from(realMap.entries()).map(([uid, cartels]) => ({
                uid,
                is_admin: this.isAdmin(uid),
                cartels: cartels.sort((a, b) => a - b)
            })),
            admin_ids: Array.from(this.adminIds),
            timing: {
                selection_seconds: this.selection_seconds,
                draw_interval: this.draw_interval,
                result_seconds: this.result_seconds,
                min_players: this.min_players,
                ticket_price: this.ticket_price,
                prize_per_cartel: this.prize_per_cartel
            },
            bot_settings: { ...this.botSettings }
        };
    }

    async _tick() {
        if (this.paused) return;
        let now = Date.now() / 1000;
        if (this.phase === 'selection') {
            if (!this._botsInjected) {
                this._initBotsQueue();
                this._botsInjected = true;
            }
            this._processBotQueue();
            if (now >= this.phase_ends_at) {
                let activePlayers = new Set(Object.values(this.cartels)).size;
                if (activePlayers < this.min_players) {
                    this.phase_ends_at = now + this.selection_seconds;
                    this._bumpSeq();
                } else {
                    this.phase = 'locking';
                    this._bumpSeq();
                    await this._do_lock(this.cartels);
                }
            }
        } else if (this.phase === 'drawing') {
            if (now >= this.next_draw_at) {
                this._draw_one(now);
            }
        } else if (this.phase === 'settling') {
            await this._do_settle();
        } else if (this.phase === 'result') {
            if (now >= this.phase_ends_at) {
                this._newRound();
            }
        }
    }

    _initBotsQueue() {
        const targetBotCount = Math.min(400, Math.max(0, this.botSettings.botCount || 0));
        const cardsPerBot = Math.min(4, Math.max(1, this.botSettings.botCardsPerUser || 2));
        this.botProfiles = {};
        this.botQueue = [];

        for (let i = 0; i < targetBotCount; i++) {
            const botId = `bot_${i + 1}`;
            const randomName = ETHIOPIAN_NAMES[Math.floor(Math.random() * ETHIOPIAN_NAMES.length)];
            this.botProfiles[botId] = { name: randomName };
            const howManyCards = Math.floor(Math.random() * cardsPerBot) + 1;
            for (let c = 0; c < howManyCards; c++) {
                this.botQueue.push(botId);
            }
        }
        this.botQueue.sort(() => Math.random() - 0.5);
        this.botInjectIndex = 0;
    }

    _processBotQueue() {
        if (!this.botQueue || this.botInjectIndex >= this.botQueue.length) return;
        let steps = Math.floor(Math.random() * 3) + 1;
        let availableCartels = [];
        for (let i = 1; i <= CARTEL_COUNT; i++) {
            if (!this.cartels[i]) availableCartels.push(i);
        }
        if (availableCartels.length === 0) return;

        let changed = false;
        for (let s = 0; s < steps && this.botInjectIndex < this.botQueue.length && availableCartels.length > 0; s++) {
            const botId = this.botQueue[this.botInjectIndex++];
            const botExistingCount = Object.values(this.cartels).filter(u => u === botId).length;
            if (botExistingCount >= this.max_selection) continue;

            const idx = Math.floor(Math.random() * availableCartels.length);
            const chosenCartel = availableCartels[idx];
            availableCartels[idx] = availableCartels[availableCartels.length - 1];
            availableCartels.pop();

            this.cartels[chosenCartel] = botId;
            changed = true;
        }
        if (changed) this._bumpSeq();
    }

    async _do_lock(snapshot) {
        let rid = this.round_id;
        await this.wallet.begin_round(rid, snapshot);

        let realSnapshot = {};
        for (let [cartel, uid] of Object.entries(snapshot)) {
            if (!String(uid).startsWith('bot_')) realSnapshot[cartel] = uid;
        }

        let byUser = {};
        for (let [cartel, uid] of Object.entries(realSnapshot)) {
            if (!byUser[uid]) byUser[uid] = [];
            byUser[uid].push(Number(cartel));
        }

        let paid = {};
        this.restrictedUsers = new Set();
        for (let [uid, cartels] of Object.entries(byUser)) {
            let res = await this.wallet.charge(uid, cartels.length * this.ticket_price, rid, cartels.length);
            if (res !== null) {
                this.invalidateBalanceCache(uid);
                for (let c of cartels) paid[c] = uid;
                if (this.botSettings.restrictDepositedWin && !this.isAdmin(uid)) {
                    try {
                        const prof = await this.wallet.profile(uid);
                        if (prof && prof.has_deposited) {
                            this.restrictedUsers.add(uid);
                        }
                    } catch (_) {}
                }
            } else {
                this.invalidateBalanceCache(uid);
                await this.wallet.refund(uid, rid);
            }
        }

        for (let [cartel, uid] of Object.entries(snapshot)) {
            if (String(uid).startsWith('bot_')) paid[cartel] = uid;
        }

        this.cartels = paid;
        try {
            await this.wallet.start_drawing(rid, paid);
        } catch (error) {
            let realPaidUids = [...new Set(Object.values(paid).filter(u => !String(u).startsWith('bot_')))];
            await this.wallet.cancel_round(rid, realPaidUids);
            this.cartels = {};
            this.phase = 'selection';
            this.phase_ends_at = Date.now() / 1000 + this.selection_seconds;
            this._bumpSeq();
            return;
        }

        let order = Array.from({ length: BALLS }, (_, i) => i + 1);
        for (let i = order.length - 1; i > 0; i--) {
            let j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        this.draw_order = order;
        this.drawn = [];
        this.phase = 'drawing';
        this.next_draw_at = Date.now() / 1000 + this.first_draw_delay;
        this._bumpSeq();
    }

    _draw_one(now, manualOverride = false) {
        let nextIndex = this.drawn.length;
        if (nextIndex >= this.draw_order.length) {
            this._pending = ['none', []];
            this.phase = 'settling';
            this._bumpSeq();
            return;
        }

        // Apply restrictDepositedWin safely when enabled and unrestricted cartels exist
        if (!manualOverride && this.botSettings.restrictDepositedWin && this.restrictedUsers.size > 0) {
            const hasUnrestricted = Object.values(this.cartels).some(u => !this.restrictedUsers.has(u));
            if (hasUnrestricted) {
                for (let look = nextIndex; look < this.draw_order.length; look++) {
                    const candidate = this.draw_order[look];
                    const testSet = new Set(this.drawn);
                    testSet.add(candidate);
                    let restrictedWouldWin = false;
                    let unrestrictedAlsoWins = false;
                    for (const [c, uid] of Object.entries(this.cartels)) {
                        if (checkBingo(generateMatrix(Number(c)), testSet)) {
                            if (this.restrictedUsers.has(uid)) restrictedWouldWin = true;
                            else unrestrictedAlsoWins = true;
                        }
                    }
                    if (!restrictedWouldWin || unrestrictedAlsoWins) {
                        if (look !== nextIndex) {
                            [this.draw_order[nextIndex], this.draw_order[look]] = [this.draw_order[look], this.draw_order[nextIndex]];
                        }
                        break;
                    }
                }
            }
        }

        let number = this.draw_order[nextIndex];
        this.drawn.push(number);

        let drawnSet = new Set(this.drawn);
        let winning = [];

        for (let [cartel] of Object.entries(this.cartels)) {
            if (checkBingo(generateMatrix(Number(cartel)), drawnSet)) {
                winning.push(Number(cartel));
            }
        }

        if (winning.length > 0) {
            this._pending = ['win', winning];
            this.phase = 'settling';
        } else if (this.drawn.length >= BALLS) {
            this._pending = ['none', []];
            this.phase = 'settling';
        } else {
            this.next_draw_at = manualOverride
                ? now + this.draw_interval
                : Math.max(this.next_draw_at + this.draw_interval, now);
        }
        this._bumpSeq();
    }

    async _do_settle() {
        let rid = this.round_id;
        let tickets = { ...this.cartels };
        let pending = this._pending || ['none', []];
        let pool = 0;

        if (pending[0] === 'win') {
            let wins = pending[1];
            pool = Object.keys(tickets).length * this.prize_per_cartel;
            let share = Math.round((pool / wins.length) * 100) / 100;
            let payouts = {};
            let realWinnersList = [];

            for (let c of wins) {
                let uid = tickets[c];
                if (!String(uid).startsWith('bot_')) {
                    payouts[uid] = (payouts[uid] || 0) + share;
                }
                realWinnersList.push({ cartel: c, uid: uid });
            }

            let profiles = {};
            for (let uid of Object.keys(payouts)) {
                profiles[uid] = await this.wallet.profile(uid) || {};
            }

            if (Object.keys(payouts).length > 0) {
                await this.wallet.prepare_settlement(rid, payouts);
                await this.wallet.settle(rid, payouts);
            }

            this.winners = realWinnersList.map(w => {
                const isBot = String(w.uid).startsWith('bot_');
                let winnerName = isBot ? (this.botProfiles[w.uid]?.name || 'ተጫዋች') : (profiles[w.uid]?.name || profiles[w.uid]?.username || 'Player');
                return { uid: w.uid, cartel: w.cartel, prize: share, name: winnerName };
            });
            this.no_winner = false;
        } else {
            let realUserIds = [...new Set(Object.entries(tickets).filter(([c, u]) => !String(u).startsWith('bot_')).map(([c, u]) => u))];
            await this.wallet.cancel_round(rid, realUserIds);
            this.winners = [];
            this.no_winner = true;
        }

        this.invalidateBalanceCache();
        this.phase = 'result';
        this.phase_ends_at = Date.now() / 1000 + this.result_seconds;
        this._bumpSeq();
    }
}

module.exports = {
    GameEngine,
    TICKET_PRICE: DEFAULT_TICKET_PRICE,
    PRIZE_PER_CARTEL: DEFAULT_PRIZE_PER_CARTEL,
    MAX_SELECTION,
    CARTEL_COUNT,
    generateMatrix
};
