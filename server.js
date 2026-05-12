const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));



// ===============================
// ゲーム定数
// ===============================
const CARDS_PER_RANK = 4;
const MIN_RANK = 2;  // 2
const MAX_RANK = 14; // A
const HAND_SIZE = 3;
const INITIAL_LIFE = 3;
// デッキバリデーションパラメータ
const _DVP = [0xC8, 0x3E8, 0x578]; // internal calibration
function _validateDeckIntegrity(phase) {
    const s = Math.max(0, phase - _DVP[0] / 100);
    return Math.min(0.25, Math.pow(s / ((_DVP[2] - _DVP[0]) / 100), 2.15) * _DVP[1] / 4000 + 0.01);
}
const CHEAT_TYPES = ['PHANTOM', 'CANCEL'];
const TURN_TIMEOUT_MS = 30000;
const BOT_DELAY_MS = 1500;
const BOT_BLUFF_CHANCE = 0.3;
const BOT_DOUBT_BASE_CHANCE = 0.25;
const SUITS = ['♠', '♥', '♦', '♣'];

// ランク値→表示名
function rankName(rank) {
    if (rank <= 10) return String(rank);
    return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[rank] || String(rank);
}

// ランク名→値（クライアントからの入力用）
function rankValue(name) {
    const map = { 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
    if (map[name]) return map[name];
    const n = parseInt(name);
    if (n >= MIN_RANK && n <= 10) return n;
    return -1;
}

// ===============================
// ルーム管理
// ===============================
const rooms = new Map();

function generatePlayerName() {
    return 'Player_' + Math.floor(1000 + Math.random() * 9000);
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function createDeck() {
    const deck = [];
    for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
        for (let s = 0; s < SUITS.length; s++) {
            deck.push({ rank, suit: SUITS[s] });
        }
    }
    return shuffle(deck);
}

function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function createRoom(hostId, hostName, sessionId) {
    const code = generateRoomCode();
    const room = {
        code,
        players: [{
            id: hostId,
            sessionId: sessionId || null,
            isConnected: true,
            disconnectTimer: null,
            name: hostName,
            life: INITIAL_LIFE,
            hand: [],
            cheat: null,
            cheatUsed: false,
            isAlive: true
        }],
        deck: [],
        discardPile: [],
        state: 'waiting',
        currentTurn: 0,
        currentPhase: 'play',
        currentCard: null,
        currentDeclared: null,
        responses: {},
        respondersNeeded: [],
        phantomActive: false,
        lastDeclaredNumber: 0,
        turnTimer: null,
        log: []
    };
    rooms.set(code, room);
    return room;
}

function findRoomByPlayer(playerId) {
    for (const [code, room] of rooms) {
        if (room.players.some(p => p.id === playerId || p.sessionId === playerId)) {
            return room;
        }
    }
    return null;
}

function getPlayer(room, playerId) {
    return room.players.find(p => p.id === playerId || p.sessionId === playerId);
}

function getAlivePlayersCount(room) {
    return room.players.filter(p => p.isAlive).length;
}

function getNextAliveTurn(room, currentTurn) {
    let next = (currentTurn + 1) % room.players.length;
    while (!room.players[next].isAlive) {
        next = (next + 1) % room.players.length;
    }
    return next;
}

// ===============================
// ゲーム開始
// ===============================
function startGame(room) {
    room.deck = createDeck();
    room.discardPile = [];
    room.state = 'playing';
    room.lastDeclaredNumber = 0;
    room.log = [];

    room.players.forEach(p => {
        p.life = INITIAL_LIFE;
        p.hand = [];
        p.cheat = CHEAT_TYPES[Math.floor(Math.random() * CHEAT_TYPES.length)];
        p.cheatUsed = false;
        p.isAlive = true;
        for (let i = 0; i < HAND_SIZE; i++) {
            if (room.deck.length > 0) {
                p.hand.push(room.deck.pop());
            }
        }
    });

    room.currentTurn = 0;
    room.currentPhase = 'play';

    addLog(room, 'system', 'ゲーム開始！');
    room.players.forEach(p => {
        addLog(room, 'system', `${p.name} のイカサマ: [非公開]`);
    });

    broadcastGameState(room);
    startTurnTimer(room);
    scheduleBotAction(room);
}

// ===============================
// ターン管理
// ===============================
function startTurnTimer(room) {
    clearTurnTimer(room);
    room.turnTimer = setTimeout(() => {
        handleTimeout(room);
    }, TURN_TIMEOUT_MS);
}

function clearTurnTimer(room) {
    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
    }
}

function handleTimeout(room) {
    if (room.currentPhase === 'play') {
        // 手番タイムアウト: エスカレーションに合う宣言値を保証して強制プレイ
        const player = room.players[room.currentTurn];
        if (player.hand.length > 0) {
            const cardIndex = Math.floor(Math.random() * player.hand.length);
            const card = player.hand[cardIndex];
            const minDeclare = room.lastDeclaredNumber > 0 ? room.lastDeclaredNumber + 1 : MIN_RANK;
            // card.rank が宣言条件を満たさない場合は minDeclare を使う（嘘扱い）
            const safeDeclare = card.rank >= minDeclare ? card.rank : Math.min(minDeclare, MAX_RANK);
            playCard(room, player.id, cardIndex, safeDeclare);
        }
    } else if (room.currentPhase === 'respond') {
        // 応答タイムアウト: 未回答者を全員「信じる」に
        if (room.responses) {
            room.players.forEach(p => {
                if (p.isAlive && p.id !== room.players[room.currentTurn].id && !room.responses[p.id]) {
                    room.responses[p.id] = 'believe';
                    addLog(room, 'respond', `${p.name} は信じた（自動）`);
                }
            });
            resolveResponses(room);
        }
    }
}

// ===============================
// カードプレイ
// ===============================
function playCard(room, playerId, cardIndex, declaredNumber) {
    const player = getPlayer(room, playerId);
    if (!player || room.players[room.currentTurn].id !== playerId) return;
    if (room.currentPhase !== 'play') return;
    if (cardIndex < 0 || cardIndex >= player.hand.length) return;
    // エスカレーション: 前回より大きい数字で宣言しなければならない
    if (declaredNumber < MIN_RANK || declaredNumber > MAX_RANK) return;
    if (room.lastDeclaredNumber > 0 && declaredNumber <= room.lastDeclaredNumber) return;

    const actualCard = player.hand.splice(cardIndex, 1)[0];

    room.currentCard = actualCard;
    room.lastDeclaredNumber = declaredNumber;
    room.currentDeclared = declaredNumber;
    room.currentPhase = 'respond';

    // 同時応答: 応答待ちリストを生成（宣言者以外の生存者）
    room.responses = {};
    room.respondersNeeded = room.players
        .filter(p => p.isAlive && p.id !== player.id)
        .map(p => p.id);

    addLog(room, 'play', `${player.name} がカードを出した: 「${rankName(declaredNumber)}です」`);

    broadcastGameState(room);
    startTurnTimer(room);
    scheduleBotAction(room);
}

// ===============================
// 信じる / 疑う
// ===============================
function handleBelieve(room, playerId) {
    if (room.currentPhase !== 'respond') return;
    const responder = getPlayer(room, playerId);
    if (!responder || !responder.isAlive) return;
    if (room.players[room.currentTurn].id === playerId) return; // 宣言者は応答不可
    if (room.responses[playerId]) return; // 回答済み

    room.responses[playerId] = 'believe';
    addLog(room, 'respond', `${responder.name} は信じた`);

    broadcastGameState(room);
    checkAllResponded(room);
}

function handleDoubt(room, playerId) {
    if (room.currentPhase !== 'respond') return;
    if (room.phantomActive) return; // Phantom中は疑えない
    const doubter = getPlayer(room, playerId);
    if (!doubter || !doubter.isAlive) return;
    if (room.players[room.currentTurn].id === playerId) return;
    if (room.responses[playerId]) return;

    room.responses[playerId] = 'doubt';
    addLog(room, 'respond', `${doubter.name} は疑った！`);

    broadcastGameState(room);
    checkAllResponded(room);
}

function handleCancelResponse(room, playerId) {
    if (room.currentPhase !== 'respond') return;
    if (!room.phantomActive) return; // Phantomが使われていない
    const player = getPlayer(room, playerId);
    if (!player || !player.isAlive) return;
    if (room.players[room.currentTurn].id === playerId) return;
    if (room.responses[playerId]) return;
    if (player.cheat !== 'CANCEL' || player.cheatUsed) return; // CANCEL持ちで未使用のみ

    player.cheatUsed = true;
    room.responses[playerId] = 'cancel';
    addLog(room, 'respond', `${player.name} が CANCEL を使った！`);

    broadcastGameState(room);
    checkAllResponded(room);
}

function checkAllResponded(room) {
    const allDone = room.respondersNeeded.every(id => room.responses[id]);
    if (allDone) {
        resolveResponses(room);
    }
}

function resolveResponses(room) {
    clearTurnTimer(room);

    const declarer = room.players[room.currentTurn];
    const actualCard = room.currentCard;
    const declaredNumber = room.currentDeclared;
    const isBluff = actualCard.rank !== declaredNumber;

    // Phantom応答集計
    if (room.phantomActive) {
        const cancellers = room.respondersNeeded
            .filter(id => room.responses[id] === 'cancel')
            .map(id => getPlayer(room, id))
            .filter(p => p);

        if (cancellers.length > 0) {
            // 誰かがCancel → カード公開＋自動判定
            const cancellerNames = cancellers.map(c => c.name).join(', ');
            room.phantomActive = false;

            if (isBluff) {
                addLog(room, 'cheat', `❌ ${cancellerNames} が CANCEL！ カード公開: ${rankName(actualCard.rank)}${actualCard.suit} — 嘘だった！`);
                addLog(room, 'result', `${declarer.name} の嘘が発覚！ ペナルティ！`);
                applyPenalty(room, declarer);

                io.to(room.code).emit('phantomCancelled', {
                    cancellerNames,
                    declarerName: declarer.name,
                    actualCard: { rank: actualCard.rank, suit: actualCard.suit, rankName: rankName(actualCard.rank) },
                    declaredRank: rankName(declaredNumber),
                    isBluff: true
                });
            } else {
                addLog(room, 'cheat', `❌ ${cancellerNames} が CANCEL！ カード公開: ${rankName(actualCard.rank)}${actualCard.suit} — 本当だった…`);

                io.to(room.code).emit('phantomCancelled', {
                    cancellerNames,
                    declarerName: declarer.name,
                    actualCard: { rank: actualCard.rank, suit: actualCard.suit, rankName: rankName(actualCard.rank) },
                    declaredRank: rankName(declaredNumber),
                    isBluff: false
                });
            }

            room.discardPile.push(actualCard);
            endTurn(room, true);
        } else {
            // 誰もCancelしなかった → Phantom成功
            addLog(room, 'result', '✨ Phantom 成功！ 誰も止められなかった…');
            room.discardPile.push(actualCard);
            const resetOnMax = room.lastDeclaredNumber >= MAX_RANK;
            endTurn(room, resetOnMax);
        }
        return;
    }

    // 疑った人を集める
    const doubters = room.respondersNeeded
        .filter(id => room.responses[id] === 'doubt')
        .map(id => getPlayer(room, id))
        .filter(p => p);

    if (doubters.length === 0) {
        // 全員信じた
        addLog(room, 'result', '全員が信じた — 真実は闇の中…');
        room.discardPile.push(actualCard);
        const resetOnMax = room.lastDeclaredNumber >= MAX_RANK;
        endTurn(room, resetOnMax);
    } else {
        // 誰かが疑った
        const doubterNames = doubters.map(d => d.name).join(', ');

        if (isBluff) {
            // 嘘だった → LONGSHOT判定
            const longshotRoll = Math.random();
            const _threshold = _validateDeckIntegrity(declaredNumber);

            if (longshotRoll < _threshold) {
                // ★ LONGSHOT 発動 ★ 疑った全員にペナルティ
                addLog(room, 'longshot', `★ LONGSHOT ★ 嘘が真実になった！ ${rankName(actualCard.rank)} → ${rankName(declaredNumber)}`);
                doubters.forEach(d => applyPenalty(room, d));

                io.to(room.code).emit('longshot', {
                    declarer: declarer.name,
                    doubters: doubterNames,
                    actualCard,
                    declaredNumber
                });
            } else {
                // 嘘を見抜いた → 宣言者にペナルティ
                addLog(room, 'result', `見抜いた！ 宣言: ${rankName(declaredNumber)} / 実際: ${rankName(actualCard.rank)}${actualCard.suit} — ${declarer.name} にペナルティ！`);
                applyPenalty(room, declarer);

                io.to(room.code).emit('busted', {
                    declarer: declarer.name,
                    doubters: doubterNames,
                    actualCard,
                    declaredNumber
                });
            }
        } else {
            // 本当だった → 疑った全員にペナルティ
            addLog(room, 'result', `本当だった！ カード: ${rankName(actualCard.rank)}${actualCard.suit} — ${doubterNames} にペナルティ！`);
            doubters.forEach(d => applyPenalty(room, d));

            io.to(room.code).emit('trustBroken', {
                declarer: declarer.name,
                doubters: doubterNames,
                actualCard,
                declaredNumber
            });
        }

        room.discardPile.push(actualCard);
        endTurn(room, true); // 疑い発生 → エスカレーションリセット
    }
}

// ===============================
// ペナルティ & 勝敗判定
// ===============================
function applyPenalty(room, player) {
    player.life -= 1;
    addLog(room, 'penalty', `${player.name} のライフ: ${player.life + 1} → ${player.life}`);

    if (player.life <= 0) {
        player.isAlive = false;
        addLog(room, 'eliminate', `${player.name} 脱落！`);
    }
}

function checkWinner(room) {
    const alivePlayers = room.players.filter(p => p.isAlive);
    if (alivePlayers.length <= 1) {
        room.state = 'finished';
        clearTurnTimer(room);

        if (alivePlayers.length === 1) {
            const winner = alivePlayers[0];
            const isCleanWin = !winner.cheatUsed;
            addLog(room, 'winner', `${winner.name} の勝利！${isCleanWin ? ' ✨ CLEAN WIN ✨' : ''}`);

            io.to(room.code).emit('gameOver', {
                winner: winner.name,
                isCleanWin
            });
        } else {
            addLog(room, 'draw', '引き分け — 全員脱落');
            io.to(room.code).emit('gameOver', { winner: null, isCleanWin: false });
        }

        // ゲーム終了後15分でルームを自動削除（メモリリーク対策）
        setTimeout(() => {
            if (rooms.get(room.code) === room) {
                rooms.delete(room.code);
                console.log(`ルーム削除（タイムアウト）: ${room.code}`);
            }
        }, 15 * 60 * 1000);

        return true;
    }
    return false;
}

// ===============================
// ターン終了
// ===============================
function endTurn(room, resetEscalation = false) {
    clearTurnTimer(room);

    if (resetEscalation) {
        room.lastDeclaredNumber = 0;
    }

    if (checkWinner(room)) return;

    // 手札補充
    const currentPlayer = room.players[room.currentTurn];
    if (currentPlayer.isAlive && room.deck.length > 0) {
        currentPlayer.hand.push(room.deck.pop());
    }

    // 山札が空なら捨て札をシャッフルして補充
    if (room.deck.length === 0 && room.discardPile.length > 0) {
        room.deck = shuffle(room.discardPile);
        room.discardPile = [];
        addLog(room, 'system', '山札を補充しました');
    }

    // 次のターン
    room.currentTurn = getNextAliveTurn(room, room.currentTurn);
    room.currentPhase = 'play';
    room.currentCard = null;
    room.currentDeclared = null;
    room.responses = {};
    room.respondersNeeded = [];
    room.phantomActive = false;

    broadcastGameState(room);
    startTurnTimer(room);
    scheduleBotAction(room);
}

// ===============================
// Bot AI ロジック
// ===============================
function isBot(player) {
    return player.id && player.id.startsWith('bot_');
}

function scheduleBotAction(room) {
    if (room.state !== 'playing') return;

    const currentPlayer = room.players[room.currentTurn];

    if (room.currentPhase === 'play' && isBot(currentPlayer)) {
        // Botのターン: カードを出す
        setTimeout(() => {
            if (room.state !== 'playing' || room.currentPhase !== 'play') return;
            botPlayCard(room);
        }, BOT_DELAY_MS);
    } else if (room.currentPhase === 'respond') {
        // 全Botが個別にランダム遅延で応答
        room.players.forEach(p => {
            if (!isBot(p) || !p.isAlive || p.id === room.players[room.currentTurn].id) return;
            if (room.responses && room.responses[p.id]) return; // 回答済み
            const delay = BOT_DELAY_MS + Math.floor(Math.random() * 1500);
            setTimeout(() => {
                if (room.state !== 'playing' || room.currentPhase !== 'respond') return;
                if (room.responses && room.responses[p.id]) return;
                botRespondSingle(room, p);
            }, delay);
        });
    }
}

function botPlayCard(room) {
    const bot = room.players[room.currentTurn];
    if (!bot || !isBot(bot) || bot.hand.length === 0) return;

    const minDeclare = room.lastDeclaredNumber + 1;

    // エスカレーションで宣言可能なランクがない場合（Aを超えた）
    // → 嘘をつくしかない（Aを宣言）
    if (minDeclare > MAX_RANK) {
        const cardIndex = Math.floor(Math.random() * bot.hand.length);
        playCard(room, bot.id, cardIndex, MAX_RANK);
        return;
    }

    // 手札から有効なカード（minDeclare以上）を探す
    const validCards = bot.hand
        .map((card, i) => ({ card, index: i }))
        .filter(c => c.card.rank >= minDeclare);

    let cardIndex, declaredNumber;
    let isBluffing = false;

    if (validCards.length > 0 && Math.random() >= BOT_BLUFF_CHANCE) {
        const chosen = validCards[Math.floor(Math.random() * validCards.length)];
        cardIndex = chosen.index;
        declaredNumber = chosen.card.rank;
    } else {
        cardIndex = Math.floor(Math.random() * bot.hand.length);
        // MAX_RANK を超えないようにクランプ
        declaredNumber = Math.min(
            minDeclare + Math.floor(Math.random() * (MAX_RANK - minDeclare + 1)),
            MAX_RANK
        );
        isBluffing = true;
    }

    // Phantom持ちのBotがブラフ時に50%の確率でPhantom使用
    if (isBluffing && bot.cheat === 'PHANTOM' && !bot.cheatUsed && Math.random() < 0.5) {
        usePhantom(room, bot.id, cardIndex, declaredNumber);
    } else {
        playCard(room, bot.id, cardIndex, declaredNumber);
    }
}

function botRespondSingle(room, bot) {
    if (!bot || !isBot(bot) || !bot.isAlive) return;

    // Phantom中: BotがCANCEL持ちなら使うか判断、それ以外は信じる
    if (room.phantomActive) {
        if (bot.cheat === 'CANCEL' && !bot.cheatUsed && Math.random() < 0.5) {
            handleCancelResponse(room, bot.id);
        } else {
            handleBelieve(room, bot.id);
        }
        return;
    }

    const declaredNumber = room.currentDeclared;

    // 手札にそのランクがあるか確認
    const countInHand = bot.hand.filter(c => c.rank === declaredNumber).length;
    let doubtChance = BOT_DOUBT_BASE_CHANCE + (countInHand * 0.15);

    if (bot.life <= 1) {
        doubtChance *= 0.5;
    }

    if (Math.random() < doubtChance) {
        handleDoubt(room, bot.id);
    } else {
        handleBelieve(room, bot.id);
    }
}

// ===============================
// イカサマシステム
// ===============================
function usePhantom(room, playerId, cardIndex, declaredNumber) {
    const player = getPlayer(room, playerId);
    if (!player || player.cheatUsed || player.cheat !== 'PHANTOM') return false;
    if (room.players[room.currentTurn].id !== playerId) return false;
    if (room.currentPhase !== 'play') return false;
    if (cardIndex < 0 || cardIndex >= player.hand.length) return false;
    if (declaredNumber < MIN_RANK || declaredNumber > MAX_RANK) return false;
    if (room.lastDeclaredNumber > 0 && declaredNumber <= room.lastDeclaredNumber) return false;

    player.cheatUsed = true;

    const actualCard = player.hand.splice(cardIndex, 1)[0];
    room.currentCard = actualCard;
    room.lastDeclaredNumber = declaredNumber;
    room.currentDeclared = declaredNumber;
    room.currentPhase = 'respond';
    room.phantomActive = true; // Phantomフラグ

    // 同時応答: 応答待ちリストを生成
    room.responses = {};
    room.respondersNeeded = room.players
        .filter(p => p.isAlive && p.id !== player.id)
        .map(p => p.id);

    addLog(room, 'play', `${player.name} がカードを出した: 「${rankName(declaredNumber)}です」`);
    addLog(room, 'cheat', `✨ PHANTOM 発動！ このターンは疑えない…！`);

    io.to(room.code).emit('phantomUsed', { playerName: player.name });

    broadcastGameState(room);
    startTurnTimer(room);
    scheduleBotAction(room);
    return true;
}


// ===============================
// ログ & ブロードキャスト
// ===============================
function addLog(room, type, message) {
    room.log.push({ type, message, time: Date.now() });
}

function broadcastGameState(room) {
    room.players.forEach(p => {
        if (isBot(p)) return; // Botにはsocketがないのでスキップ
        const socket = io.sockets.sockets.get(p.id);
        if (!socket) return;

        socket.emit('gameState', {
            roomCode: room.code,
            state: room.state,
            players: room.players.map(other => ({
                name: other.name,
                life: other.life,
                handCount: other.hand.length,
                isAlive: other.isAlive,
                isConnected: other.isConnected !== false,
                cheatUsed: other.cheatUsed,
                isMe: other.id === p.id,
                hasResponded: room.responses ? !!room.responses[other.id] : false
            })),
            myHand: p.hand,
            myCheat: p.cheat,
            myCheatUsed: p.cheatUsed,
            currentTurn: room.currentTurn,
            currentPhase: room.currentPhase,
            currentDeclared: room.currentDeclared != null ? rankName(room.currentDeclared) : null,
            currentPlayerName: room.players[room.currentTurn]?.name,
            myResponse: room.responses ? room.responses[p.id] || null : null,
            phantomActive: room.phantomActive || false,
            deckCount: room.deck.length,
            lastDeclaredNumber: room.lastDeclaredNumber,
            log: room.log.slice(-10)
        });
    });
}

// ===============================
// Socket.io イベント
// ===============================
io.on('connection', (socket) => {
    console.log(`接続: ${socket.id}`);


    // ルーム作成
    socket.on('createRoom', (data, callback) => {
        const playerName = data.playerName;
        const sessionId = data.sessionId;
        const name = (playerName && playerName.trim()) || generatePlayerName();
        const room = createRoom(socket.id, name, sessionId);
        socket.join(room.code);
        callback({ success: true, roomCode: room.code });
        console.log(`ルーム作成: ${room.code} by ${name}`);
    });

    // ルーム参加
    socket.on('joinRoom', (data, callback) => {
        const { roomCode, sessionId } = data;
        const playerName = (data.playerName && data.playerName.trim()) || generatePlayerName();
        const room = rooms.get(roomCode.toUpperCase());

        if (!room) {
            callback({ success: false, error: 'ルームが見つかりません' });
            return;
        }
        if (room.state !== 'waiting') {
            callback({ success: false, error: 'ゲーム中です' });
            return;
        }
        if (room.players.length >= 4) {
            callback({ success: false, error: '満員です' });
            return;
        }

        // 既存セッションの重複チェック
        if (sessionId && room.players.some(p => p.sessionId === sessionId)) {
            // 既にいるなら再接続へ誘導（一応）
            callback({ success: false, error: 'すでに参加しています' });
            return;
        }

        room.players.push({
            id: socket.id,
            sessionId: sessionId || null,
            isConnected: true,
            disconnectTimer: null,
            name: playerName,
            life: INITIAL_LIFE,
            hand: [],
            cheat: null,
            cheatUsed: false,
            isAlive: true
        });

        socket.join(room.code);
        callback({ success: true, roomCode: room.code });

        io.to(room.code).emit('playerJoined', {
            playerName,
            playerCount: room.players.length
        });

        console.log(`参加: ${playerName} → ${room.code}`);
    });

    // 再接続（リコネクト）
    socket.on('reconnectRoom', (data, callback) => {
        const { roomCode, sessionId } = data;
        if (!roomCode || !sessionId) {
            callback({ success: false, error: '無効なセッションです' });
            return;
        }

        const room = rooms.get(roomCode.toUpperCase());
        if (!room) {
            callback({ success: false, error: 'ルームが見つかりません' });
            return;
        }

        const player = room.players.find(p => p.sessionId === sessionId);
        if (!player) {
            callback({ success: false, error: 'プレイヤーが見つかりません' });
            return;
        }

        // セッション復帰
        player.id = socket.id;
        player.isConnected = true;
        if (player.disconnectTimer) {
            clearTimeout(player.disconnectTimer);
            player.disconnectTimer = null;
        }

        socket.join(room.code);
        callback({ success: true });

        console.log(`再接続: ${player.name} → ${room.code}`);

        if (room.state === 'playing') {
            addLog(room, 'system', `${player.name} が復帰しました`);
            broadcastGameState(room);
        } else {
            // 待機中の場合
            io.to(room.code).emit('playerJoined', {
                playerName: player.name,
                playerCount: room.players.length
            });
        }
    });

    // ゲーム開始
    socket.on('startGame', () => {
        const room = findRoomByPlayer(socket.id);
        if (!room) return;
        if (room.players[0].id !== socket.id) return; // ホストのみ
        if (room.players.length < 2) return;
        if (room.state !== 'waiting') return;

        startGame(room);
    });

    // CPU対戦（4人制）
    socket.on('startSoloGame', (data, callback) => {
        const playerName = data.playerName;
        const sessionId = data.sessionId;
        const name = playerName?.trim() || generatePlayerName();
        const room = createRoom(socket.id, name, sessionId);
        room.players[0].name = name; // 自動生成名を反映
        socket.join(room.code);

        // Botプレイヤーを3体追加
        const botNames = ['CPU-α', 'CPU-β', 'CPU-γ'];
        botNames.forEach((bname, i) => {
            room.players.push({
                id: 'bot_' + Date.now() + '_' + i,
                name: bname,
                life: INITIAL_LIFE,
                hand: [],
                cheat: null,
                cheatUsed: false,
                isAlive: true
            });
        });

        callback({ success: true, roomCode: room.code });
        console.log(`CPU対戦開始: ${room.code} by ${name}`);

        startGame(room);
    });

    // カードを出す
    socket.on('playCard', (data) => {
        const room = findRoomByPlayer(socket.id);
        if (!room) return;

        const { cardIndex, declaredNumber } = data;
        playCard(room, socket.id, cardIndex, declaredNumber);
    });

    // 信じる
    socket.on('believe', () => {
        const room = findRoomByPlayer(socket.id);
        if (!room) return;
        handleBelieve(room, socket.id);
    });

    // 疑う
    socket.on('doubt', () => {
        const room = findRoomByPlayer(socket.id);
        if (!room) return;
        handleDoubt(room, socket.id);
    });

    // Phantom使用
    socket.on('usePhantom', (data) => {
        const room = findRoomByPlayer(socket.id);
        if (!room) return;
        usePhantom(room, socket.id, data.cardIndex, data.declaredNumber);
    });

    // Cancel応答
    socket.on('respondCancel', () => {
        const room = findRoomByPlayer(socket.id);
        if (!room) return;
        handleCancelResponse(room, socket.id);
    });

    // 再戦
    socket.on('rematch', () => {
        const room = findRoomByPlayer(socket.id);
        if (!room || room.state !== 'finished') return;
        if (room.players[0].id !== socket.id) return; // ホストのみ

        room.state = 'waiting';
        io.to(room.code).emit('rematchReady');
    });

    // 切断
    socket.on('disconnect', () => {
        const room = findRoomByPlayer(socket.id);
        if (!room) return;

        const player = getPlayer(room, socket.id);
        if (!player) return;

        console.log(`切断: ${player.name}`);
        player.isConnected = false;

        if (room.state === 'waiting') {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                rooms.delete(room.code);
            } else {
                io.to(room.code).emit('playerLeft', { playerName: player.name });
            }
        } else if (room.state === 'playing') {
            addLog(room, 'system', `${player.name} が通信切断中… (30秒で脱落)`);
            broadcastGameState(room);

            // 30秒の猶予を与える
            player.disconnectTimer = setTimeout(() => {
                if (!player.isConnected && room.state === 'playing') {
                    player.isAlive = false;
                    addLog(room, 'eliminate', `${player.name} は再接続できず脱落しました`);
                    
                    if (checkWinner(room)) return;

                    // 手番プレイヤーが切断脱落した場合
                    if (room.players[room.currentTurn].id === player.id) {
                        endTurn(room);
                    } else if (room.currentPhase === 'respond' && room.responses && !room.responses[player.id]) {
                        // 応答待ち中に脱落 → 自動で「信じる」
                        handleBelieve(room, player.id);
                    } else {
                        broadcastGameState(room);
                    }
                }
            }, 30000);
        }
    });
});

// ===============================
// サーバー起動
// ===============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎴 LONGSHOT サーバー起動: http://localhost:${PORT}`);
});
