// ===============================
// LONGSHOT — クライアントスクリプト
// ===============================
const socket = io();

// ===============================
// サウンド管理
// ===============================
const SoundManager = {
    muted: false,
    bgmList: [
        'audio/bgm_main1.mp3',
        'audio/bgm_main2.mp3',
        'audio/bgm_main3.mp3'
    ],
    bgm: null,
    sounds: {},
    init: function() {
        this.muted = localStorage.getItem('longshot_muted') === '1';
        this.updateMuteBtn();

        const btnMute = $('btnMute');
        if (btnMute) {
            btnMute.addEventListener('click', () => {
                this.muted = !this.muted;
                localStorage.setItem('longshot_muted', this.muted ? '1' : '0');
                this.updateMuteBtn();
                if (this.bgm) {
                    if (this.muted) this.bgm.pause();
                    else this.bgm.play().catch(e => console.warn('BGM play failed', e));
                }
            });
        }

        // 効果音の定義 (ファイルは後で配置する前提)
        const sfx = {
            'playCard': 'audio/se_card_play.mp3',
            'believe': 'audio/se_believe.mp3',
            'doubt': 'audio/se_doubt.mp3',
            'busted': 'audio/se_busted.mp3',
            'trustBroken': 'audio/se_trust_broken.mp3',
            'longshot': 'audio/se_longshot.mp3',
            'win': 'audio/se_win.mp3',
            'lose': 'audio/se_lose.mp3'
        };

        for (const [key, path] of Object.entries(sfx)) {
            const a = new Audio(path);
            a.preload = 'auto';
            this.sounds[key] = a;
        }

        // BGMのAudioオブジェクトは playBGM 時のランダム選択で作成します
    },
    updateMuteBtn: function() {
        const btn = $('btnMute');
        if (!btn) return;
        if (this.muted) {
            btn.classList.add('muted');
            btn.textContent = '🔈';
        } else {
            btn.classList.remove('muted');
            btn.textContent = '🔊';
        }
    },
    playBGM: function() {
        if (!this.bgm || this.bgm.paused || this.bgm.currentTime === 0) {
            // まだBGMが作成されていないか、停止中の場合は新しくランダムな曲を選ぶ
            if (this.bgm) this.bgm.pause();
            const randomPath = this.bgmList[Math.floor(Math.random() * this.bgmList.length)];
            this.bgm = new Audio(randomPath);
            this.bgm.loop = true;
            this.bgm.volume = 0.5;
        }
        if (!this.muted && this.bgm) {
            this.bgm.play().catch(e => console.warn('BGM play failed:', e));
        }
    },
    stopBGM: function() {
        if (this.bgm) {
            this.bgm.pause();
            this.bgm.currentTime = 0;
            this.bgm = null; // 次回再生時に別の曲が選ばれるようにする
        }
    },
    playSE: function(key) {
        if (this.muted || !this.sounds[key]) return;
        const clone = this.sounds[key].cloneNode();
        clone.volume = 0.8;
        clone.play().catch(e => console.warn('SE play failed:', e));
    }
};



// ===============================
// セッション管理
// ===============================
let mySessionId = localStorage.getItem('longshot_session_id');
if (!mySessionId) {
    mySessionId = 'sess_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    localStorage.setItem('longshot_session_id', mySessionId);
}


// ===============================
// 状態管理
// ===============================
let myState = {
    name: '',
    roomCode: '',
    isHost: false,
    selectedCardIndex: -1,
    selectedDeclareNumber: -1, // 内部値 2-14
    gameState: null
};

// カウントダウン管理
let countdownTimer = null;
let countdownSeconds = 0;
let lastPhase = null; // フェーズ変化検知用

const COUNTDOWN_TOTAL = 30; // TURN_TIMEOUT_MS / 1000

// LONGSHOTオーバーレイ管理
let longshotHideTimer = null;

// ログ監視用（前回のログ件数）
let lastLogCount = 0;

// ランク定義
const RANKS = [
    { value: 2, name: '2' }, { value: 3, name: '3' }, { value: 4, name: '4' },
    { value: 5, name: '5' }, { value: 6, name: '6' }, { value: 7, name: '7' },
    { value: 8, name: '8' }, { value: 9, name: '9' }, { value: 10, name: '10' },
    { value: 11, name: 'J' }, { value: 12, name: 'Q' }, { value: 13, name: 'K' },
    { value: 14, name: 'A' }
];
const MIN_RANK = 2;
const MAX_RANK = 14;

function rankNameClient(val) {
    const r = RANKS.find(r => r.value === val);
    return r ? r.name : String(val);
}

function rankValueClient(name) {
    const r = RANKS.find(r => r.name === name.toUpperCase());
    return r ? r.value : -1;
}

function isRedSuit(suit) {
    return suit === '♥' || suit === '♦';
}

// ===============================
// DOM要素
// ===============================
const $ = (id) => document.getElementById(id);

const screens = {
    lobby: $('lobby'),
    waiting: $('waiting'),
    game: $('game')
};

// ===============================
// 画面切り替え
// ===============================
function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
}

// ===============================
// ロビー
// ===============================
$('btnCreate').addEventListener('click', () => {
    const name = $('playerName').value.trim() || 'ゲスト';
    myState.name = name;
    myState.isHost = true;

    socket.emit('createRoom', { playerName: name, sessionId: mySessionId }, (res) => {
        if (res.success) {
            myState.roomCode = res.roomCode;
            showWaitingRoom();
        } else {
            $('lobbyError').textContent = res.error || 'エラーが発生しました';
        }
    });
});

$('btnSolo').addEventListener('click', () => {
    const name = $('playerName').value.trim() || 'ゲスト';
    myState.name = name;
    myState.isHost = true;

    socket.emit('startSoloGame', { playerName: name, sessionId: mySessionId }, (res) => {
        if (res.success) {
            myState.roomCode = res.roomCode;
        } else {
            $('lobbyError').textContent = res.error || 'エラーが発生しました';
        }
    });
});

$('btnJoin').addEventListener('click', () => {
    const name = $('playerName').value.trim() || 'ゲスト';
    const code = $('roomCodeInput').value.trim().toUpperCase();
    if (!code || code.length !== 4) {
        $('lobbyError').textContent = 'ルームコードを入力してください';
        return;
    }
    myState.name = name;
    myState.isHost = false;

    socket.emit('joinRoom', { roomCode: code, playerName: name, sessionId: mySessionId }, (res) => {
        if (res.success) {
            myState.roomCode = res.roomCode;
            showWaitingRoom();
        } else {
            $('lobbyError').textContent = res.error || 'エラーが発生しました';
        }
    });
});

// Enterキーで参加
$('roomCodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnJoin').click();
});
$('playerName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnCreate').click();
});

// ===============================
// 待機室
// ===============================
function showWaitingRoom() {
    showScreen('waiting');
    $('roomCodeDisplay').textContent = myState.roomCode;
    updatePlayerList([myState.name]);

    if (myState.isHost) {
        $('btnStart').style.display = 'none'; // 2人揃うまで非表示
    }
}

function updatePlayerList(names) {
    const list = $('playerList');
    list.innerHTML = '';
    names.forEach(name => {
        const item = document.createElement('div');
        item.className = 'player-list-item';
        item.textContent = name;
        list.appendChild(item);
    });
}

$('btnStart').addEventListener('click', () => {
    socket.emit('startGame');
});

socket.on('playerJoined', (data) => {
    // 待機室更新
    if (myState.isHost) {
        $('btnStart').style.display = 'block';
    }
});

// 自動再接続処理
socket.on('connect', () => {
    // もしすでにルームコードを持っていれば再接続を試みる
    if (myState.roomCode && myState.name) {
        socket.emit('reconnectRoom', { roomCode: myState.roomCode, sessionId: mySessionId }, (res) => {
            if (res.success) {
                console.log('再接続成功！');
            } else {
                console.log('再接続失敗:', res.error);
                // 再接続に失敗した場合はロビーに戻る
                showScreen('lobby');
                $('lobbyError').textContent = '再接続できませんでした。もう一度参加してください。';
                myState.roomCode = '';
            }
        });
    }
});

// ===============================
// ゲーム状態受信
// ===============================
socket.on('gameState', (state) => {
    if (state.state === 'playing') {
        if (!myState.gameState || myState.gameState.state !== 'playing') {
            SoundManager.playBGM();
        }
        showScreen('game');
    }

    myState.gameState = state;

    renderGameState(state);
});

// ===============================
// カウントダウン
// ===============================
function startCountdown() {
    stopCountdown();
    countdownSeconds = COUNTDOWN_TOTAL;
    const overlay = $('countdownOverlay');
    const numEl = $('countdownNumber');
    overlay.style.display = 'flex';
    updateCountdownDisplay(numEl, countdownSeconds);

    countdownTimer = setInterval(() => {
        countdownSeconds--;
        if (countdownSeconds <= 0) {
            stopCountdown();
            return;
        }
        updateCountdownDisplay(numEl, countdownSeconds);
    }, 1000);
}

function stopCountdown() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
    const overlay = $('countdownOverlay');
    if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.remove('danger-pos');
    }
    const numEl = $('countdownNumber');
    if (numEl) {
        numEl.classList.remove('danger', 'shake-num');
    }
}

function updateCountdownDisplay(el, sec) {
    const overlay = $('countdownOverlay');
    // 20秒以下になるまで非表示
    if (sec > 20) {
        overlay.style.display = 'none';
        return;
    }
    overlay.style.display = 'flex';
    el.textContent = sec;
    // 10秒以下でdangerクラス付与 → 赤文字＋中央移動
    if (sec <= 10) {
        el.classList.add('danger');
        overlay.classList.add('danger-pos');
    } else {
        el.classList.remove('danger');
        overlay.classList.remove('danger-pos');
    }
    // 数字が変わるたびに揺れを発動
    el.classList.remove('shake-num');
    el.offsetHeight; // reflow
    el.classList.add('shake-num');
}

// ===============================
// ゲーム描画
// ===============================
function renderGameState(state) {
    // フェーズ変化を検知してカウントダウンを制御
    const currentPhaseKey = state.state + ':' + state.currentPhase + ':' + state.currentTurn;
    if (currentPhaseKey !== lastPhase) {
        lastPhase = currentPhaseKey;
        lastLogCount = 0; // フェーズ切り替わりでログカウントをリセット
        document.querySelectorAll('.response-stamp').forEach(el => el.remove()); // 前のターンのスタンプをクリア
        if (state.state === 'playing') {
            startCountdown();
        } else {
            stopCountdown();
        }

        // フェイルセーフ: タイマーが動いていない（すでに消えているはず）のに
        // オーバーレイが表示されたままなら強制非表示
        if (!longshotHideTimer) {
            const lsOverlay = $('longshotOverlay');
            if (lsOverlay) {
                lsOverlay.style.display = 'none';
                lsOverlay.style.animation = 'none';
            }
        }
    }

    renderLifeBar(state);
    renderCheatStatus(state);
    renderLog(state.log);
    renderField(state);
    renderActions(state);
    renderHand(state);
    renderCheat(state);
    renderDeckInfo(state);
    renderAvatars(state);
}

// ===============================
// 立ち絵・アバター管理 (クライアント限定UI)
// ===============================
const CHARACTERS = {
    'CPU-α': 'alpha',
    'CPU-β': 'beta',
    'CPU-γ': 'gamma'
};

const BOT_COMMENTS = {
    'alpha': { normal: ["…", "計算通りね", "ふふっ"], doubt: ["おや？", "矛盾があるわね", "本当かしら？"], smug: ["これで決まりよ", "かかったわね", "見え透いた嘘ね"], shock: ["なっ…！", "計算外よ！", "そんな馬鹿な…"], defeat: ["くっ…", "アタシが負けるなんて…"] },
    'beta': { normal: ["イェーイ！", "遊ぼうよ！", "ウチの番ね！"], doubt: ["ウソーー！", "絶対うそ！", "怪しいなあ〜"], smug: ["どやっ！", "見たかアタシのブラフ！", "完全勝利！"], shock: ["えぇーっ！？", "マジで！？", "やられたー！"], defeat: ["うぇぇ〜ん…", "もうおしまいだぁ…"] },
    'gamma': { normal: ["……。", "ん。", "……勝つ。"], doubt: ["……嘘の匂い。", "……あやしい。", "……だめ。"], smug: ["……ふん。", "……よわい。", "……もらった。"], shock: ["……！？", "……うそ。", "……計算ミス。"], defeat: ["……。", "……しゅん。"] }
};

function renderAvatars(state) {
    const area = $('opponentsArea');
    if (!area) return;

    // DOMの初期生成 (各相手プレイヤーごとに枠を作る)
    if (area.children.length === 0) {
        state.players.forEach((p, idx) => {
            if (p.isMe) return;
            const safeId = CHARACTERS[p.name] ? CHARACTERS[p.name] : `human-${idx}`;

            // カード全体のラッパー（画像枠＋名前を縦並び）
            const card = document.createElement('div');
            card.className = 'opponent-card';

            const container = document.createElement('div');
            container.className = 'opponent-container';
            container.id = `avatar-container-${safeId}`;

            const img = document.createElement('img');
            img.className = 'character-image';
            img.id = `avatar-img-${safeId}`;

            // 人間プレイヤーの場合は画像なし、CPUのみ表示
            if (CHARACTERS[p.name]) {
                img.src = `images/${CHARACTERS[p.name]}_normal.png?v=2`;
            } else {
                img.style.display = 'none';
            }
            img.alt = p.name;

            const bubble = document.createElement('div');
            bubble.className = 'chat-bubble';
            bubble.id = `avatar-bubble-${safeId}`;

            // 名前とライフの表示領域（枠の直下）
            const infoDiv = document.createElement('div');
            infoDiv.className = 'opponent-info';

            const nameEl = document.createElement('div');
            nameEl.className = 'opponent-name';
            nameEl.textContent = p.name;

            const lifeEl = document.createElement('div');
            lifeEl.className = 'opponent-life';
            lifeEl.id = `avatar-life-${safeId}`;

            infoDiv.appendChild(nameEl);
            infoDiv.appendChild(lifeEl);

            container.appendChild(img);
            card.appendChild(container);
            if (CHARACTERS[p.name]) {
                // バブルは opponent-card に直接追加（overflow:hidden の container の外）
                bubble.style.position = 'absolute';
                bubble.style.top = '-20px';
                bubble.style.right = '-55px';
                card.appendChild(bubble);
            }
            card.appendChild(infoDiv);   // infoは card の子（container の外）
            area.appendChild(card);
        });
    }

    // 状況に応じた表情とライフの更新
    state.players.forEach((p, idx) => {
        if (p.isMe) return;
        const safeId = CHARACTERS[p.name] ? CHARACTERS[p.name] : `human-${idx}`;

        // ライフ更新
        const lifeEl = $(`avatar-life-${safeId}`);
        if (lifeEl) {
            lifeEl.innerHTML = '';
            if (!p.isAlive) {
                lifeEl.textContent = '💀 脱落';
                lifeEl.style.color = 'var(--text-secondary)';
            } else {
                lifeEl.style.color = ''; // インラインスタイルをリセット（CSS の crimson-bright に戻す）
                for (let i = 0; i < p.life; i++) {
                    const heart = document.createElement('span');
                    heart.className = 'heart';
                    heart.textContent = '♥';
                    lifeEl.appendChild(heart);
                }
            }
        }

        // 立ち絵更新
        if (!CHARACTERS[p.name]) return;
        const img = $(`avatar-img-${safeId}`);
        if (!img) return;

        let exp = 'normal';
        const isCurrentTurn = state.players[state.currentTurn].name === p.name;

        // ライフ0（脱落）のみ敗北顔。ライフ1は通常顔のまま
        if (!p.isAlive) {
            exp = 'defeat';
        } else if (state.phantomActive && !isCurrentTurn) {
            exp = 'shock'; // 他人がPhantom使ったら全員驚く
        } else if (isCurrentTurn && state.currentPhase === 'respond') {
            exp = 'smug'; // 自分がカードを出した直後はドヤ顔
        } else if (state.currentPhase === 'respond' && p.hasResponded) {
            // 応答完了後は基本顔
            exp = 'normal';
        }

        // 切断中対応
        if (p.isConnected === false) {
            if (lifeEl && p.isAlive) {
                lifeEl.textContent = '🔌 切断中';
                lifeEl.style.color = 'var(--text-secondary)';
            }
            if (img) {
                img.style.opacity = '0.3';
                img.style.filter = 'grayscale(100%)';
            }
        } else {
            if (img) {
                img.style.opacity = '1';
                img.style.filter = 'none';
            }
        }

        // srcを切り替え
        const newSrc = `images/${CHARACTERS[p.name]}_${exp}.png?v=2`;
        if (img && img.getAttribute('src') !== newSrc) {
            img.src = newSrc;
        }
    });
}

// ライフバー
function renderLifeBar(state) {
    const bar = $('lifeBar');
    
    // 自分のプレイヤー情報を探す
    const me = state.players.find(p => p.isMe);
    if (!me) {
        bar.innerHTML = '';
        return;
    }

    // すでに要素があれば差分更新
    let div = bar.querySelector('.life-player');
    let hearts = bar.querySelector('.life-hearts');
    let nameEl = bar.querySelector('.life-name');

    if (!div) {
        bar.innerHTML = ''; // 初期化
        div = document.createElement('div');
        div.className = 'life-player is-me';
        
        nameEl = document.createElement('span');
        nameEl.className = 'life-name';
        
        hearts = document.createElement('span');
        hearts.className = 'life-hearts';

        div.appendChild(nameEl);
        div.appendChild(hearts);
        bar.appendChild(div);
    }

    // クラスの更新
    div.className = 'life-player is-me';
    if (!me.isAlive) div.classList.add('is-dead');
    if (state.players.findIndex(p => p.isMe) === state.currentTurn && me.isAlive) div.classList.add('is-turn');

    nameEl.textContent = me.name;

    // ライフハートの更新
    let heartsHtml = '';
    for (let h = 0; h < 3; h++) {
        heartsHtml += h < me.life
            ? '<span class="heart-full">♥</span>'
            : '<span class="heart-empty">♡</span>';
    }
    if (hearts.innerHTML !== heartsHtml) {
        hearts.innerHTML = heartsHtml;
    }
}

// イカサマステータスエリア（ライフバー上の独立エリア）
function renderCheatStatus(state) {
    const area = $('cheatStatus');
    if (!area) return;
    area.innerHTML = '';

    if (!state.myCheat) return;

    if (state.myCheat === 'PHANTOM') {
        if (state.myCheatUsed) return; // 使用済み → 何も出さない
        const canPhantom = state.currentPhase === 'play' && state.players[state.currentTurn].isMe;
        const btn = document.createElement('button');
        btn.className = 'btn-cheat-life' + (canPhantom ? ' active' : '');
        btn.textContent = '🃏 PHANTOM';
        btn.disabled = !canPhantom;
        // PHANTOMは表示のみ（発動は「出す」横ボタン）
        area.appendChild(btn);

    } else if (state.myCheat === 'CANCEL') {
        if (state.myCheatUsed) return; // 使用済み → 何も出さない
        const canCancel = state.currentPhase === 'respond' && state.phantomActive && !state.myResponse;
        const btn = document.createElement('button');
        btn.className = 'btn-cheat-life' + (canCancel ? ' active' : '');
        btn.textContent = '🚫 CANCEL';
        btn.disabled = !canCancel;
        btn.addEventListener('click', () => {
            if (!canCancel) return;
            handleCancel();
        });
        area.appendChild(btn);
    }

    // CANCELポップアップ制御
    const popup = $('cancelPopup');
    if (popup) {
        const showPopup = state.myCheat === 'CANCEL' && !state.myCheatUsed
            && state.currentPhase === 'respond' && state.phantomActive && !state.myResponse;
        popup.style.display = showPopup ? '' : 'none';
    }
}

// ログ
function renderLog(logs) {
    const logDiv = $('gameLog');
    logDiv.innerHTML = '';

    logs.forEach(entry => {
        const p = document.createElement('p');
        p.className = `log-${entry.type}`;
        p.textContent = entry.message;
        logDiv.appendChild(p);
    });

    logDiv.scrollTop = logDiv.scrollHeight;

    // ログの新規エントリを監視してスタンプ発動
    if (logs.length > lastLogCount) {
        const newEntries = logs.slice(lastLogCount);
        newEntries.forEach(entry => {
            // 「〇〇 は疑った！」→ Doubt スタンプ
            const doubtMatch = entry.message.match(/^(.+?) は疑った！/);
            if (doubtMatch) {
                showResponseStamps([{ name: doubtMatch[1], type: 'doubt' }]);
            }
            // 「〇〇 は信じた」→ Trust スタンプ
            const trustMatch = entry.message.match(/^(.+?) は信じた/);
            if (trustMatch) {
                showResponseStamps([{ name: trustMatch[1], type: 'trust' }]);
            }
        });
        lastLogCount = logs.length;
    }
}

// 場
function renderField(state) {
    const fieldCard = $('fieldCard');
    const declaration = $('declaration');
    const turnInfo = $('turnInfo');

    if (state.currentPhase === 'respond' && state.currentDeclared != null) {
        fieldCard.className = 'card card-back';
        fieldCard.textContent = '?';
        declaration.textContent = `「${state.currentDeclared}です」`;
        // 応答状況を表示
        const responded = state.players.filter(p => p.hasResponded && !p.isMe).length;
        const total = state.players.filter(p => p.isAlive && p !== state.players[state.currentTurn]).length - (state.players[state.currentTurn].isMe ? 0 : 0);
        turnInfo.textContent = `${state.currentPlayerName} が出した`;
    } else {
        fieldCard.className = 'card card-back';
        fieldCard.textContent = '?';
        if (state.currentPhase === 'play' && state.lastDeclaredNumber > 0) {
            declaration.textContent = `前回: ${rankNameClient(state.lastDeclaredNumber)}`;
        } else {
            declaration.textContent = '';
        }
        turnInfo.textContent = state.currentPhase === 'play'
            ? `${state.currentPlayerName} のターン`
            : '';
    }
}

function renderActions(state) {
    const declareActions = $('declareActions');
    const respondActions = $('respondActions');
    const waitingAction = $('waitingAction');

    declareActions.style.display = 'none';
    respondActions.style.display = 'none';
    waitingAction.style.display = 'none';

    const me = state.players.find(p => p.isMe);
    if (!me || !me.isAlive) return;

    if (state.currentPhase === 'play' && state.players[state.currentTurn].isMe) {
        declareActions.style.display = 'flex';
        renderDeclareNumbers();
    } else if (state.currentPhase === 'respond' && !state.players[state.currentTurn].isMe && !state.myResponse) {
        respondActions.style.display = 'flex';
        const btnDoubt = $('btnDoubt');
        if (state.phantomActive) {
            // Phantom中: 疑うボタン非表示
            btnDoubt.style.display = 'none';
            $('btnBelieve').textContent = '信じる';
        } else {
            btnDoubt.style.display = '';
            $('btnBelieve').textContent = '信じる';
        }
    } else {
        waitingAction.style.display = 'flex';
        if (state.currentPhase === 'respond' && state.myResponse) {
            $('waitingAction').querySelector('p').textContent = '✓ 回答済み — 他のプレイヤーを待っています…';
        }
    }
}

// 宣言数字ボタン
function renderDeclareNumbers() {
    const container = $('declareNumbers');
    container.innerHTML = '';
    const state = myState.gameState;
    const lastNum = (state && state.lastDeclaredNumber > 0) ? state.lastDeclaredNumber : 0;
    const minDeclare = lastNum > 0 ? lastNum + 1 : MIN_RANK;

    RANKS.forEach(({ value, name }) => {
        const btn = document.createElement('button');
        btn.className = 'number-btn';
        if (value < minDeclare) {
            btn.disabled = true;
            btn.style.opacity = '0.25';
        }
        if (value === myState.selectedDeclareNumber) btn.classList.add('selected');
        btn.textContent = name;
        btn.addEventListener('click', () => {
            if (value < minDeclare) return;
            myState.selectedDeclareNumber = value;
            renderDeclareNumbers();
            updateDeclareButton();
        });
        container.appendChild(btn);
    });

    if (minDeclare > MIN_RANK) {
        const hint = document.createElement('p');
        hint.style.cssText = 'font-size:0.75rem;color:#d4a843;width:100%;text-align:center;margin-top:0.2em;';
        hint.textContent = `↑ ${rankNameClient(minDeclare)}以上で宣言`;
        container.appendChild(hint);
    }

    // 選択中が無効化されたらリセット
    if (myState.selectedDeclareNumber > 0 && myState.selectedDeclareNumber < minDeclare) {
        myState.selectedDeclareNumber = -1;
        updateDeclareButton();
    }
}

function updateDeclareButton() {
    $('btnDeclare').disabled = (myState.selectedCardIndex < 0 || myState.selectedDeclareNumber < 0);
}

$('btnDeclare').addEventListener('click', () => {
    if (myState.selectedCardIndex < 0 || myState.selectedDeclareNumber < 0) return;

    SoundManager.playSE('playCard');
    socket.emit('playCard', {
        cardIndex: myState.selectedCardIndex,
        declaredNumber: myState.selectedDeclareNumber
    });

    myState.selectedCardIndex = -1;
    myState.selectedDeclareNumber = -1;
});

// 信じる / 疑う
$('btnBelieve').addEventListener('click', () => {
    SoundManager.playSE('believe');
    socket.emit('believe');
});

$('btnDoubt').addEventListener('click', () => {
    SoundManager.playSE('doubt');
    socket.emit('doubt');
});

// 手札
function renderHand(state) {
    const hand = $('hand');

    if (!state.myHand || state.myHand.length === 0) {
        hand.innerHTML = '';
        return;
    }

    const currentCards = hand.querySelectorAll('.card-hand');
    const myHand = state.myHand;

    // 枚数が多い場合は削除
    while (hand.children.length > myHand.length) {
        hand.removeChild(hand.lastChild);
    }

    // 各カード要素の更新または追加
    myHand.forEach((card, i) => {
        let div = hand.children[i];
        let suitSpan, rankSpan;

        if (!div) {
            // 要素が足りなければ作成
            div = document.createElement('div');
            div.className = 'card-hand';
            
            suitSpan = document.createElement('span');
            suitSpan.className = 'card-suit';
            
            rankSpan = document.createElement('span');
            rankSpan.className = 'card-rank';
            
            div.appendChild(suitSpan);
            div.appendChild(rankSpan);

            div.addEventListener('click', () => {
                const currentState = myState.gameState;
                if (currentState && currentState.currentPhase === 'play' && currentState.players[currentState.currentTurn].isMe) {
                    // クリックしたインデックス（常に最新を評価するため dataset 等を使うか再描画する）
                    // renderHand は頻繁に呼ばれるため再バインドは面倒なので、ここでは i を使用して再描画で解決する
                    myState.selectedCardIndex = (myState.selectedCardIndex === i) ? -1 : i;
                    renderHand(myState.gameState);
                    updateDeclareButton();
                }
            });
            hand.appendChild(div);
        } else {
            suitSpan = div.querySelector('.card-suit');
            rankSpan = div.querySelector('.card-rank');
        }

        // スタイルの更新
        div.className = 'card-hand';
        if (i === myState.selectedCardIndex) div.classList.add('selected');

        // 値の更新
        if (suitSpan.textContent !== card.suit) suitSpan.textContent = card.suit;
        const color = isRedSuit(card.suit) ? '#e74c3c' : '';
        if (suitSpan.style.color !== color) suitSpan.style.color = color;

        const rankName = rankNameClient(card.rank);
        if (rankSpan.textContent !== rankName) rankSpan.textContent = rankName;
    });
}

// イカサマ（「出す」横PHANTOMボタンのみ制御）
function renderCheat(state) {
    // 「出す」横のPHANTOMボタン制御
    const btnPhantomPlay = $('btnPhantomPlay');
    if (btnPhantomPlay) {
        if (state.myCheat === 'PHANTOM' && !state.myCheatUsed) {
            const canPhantom = state.currentPhase === 'play' && state.players[state.currentTurn].isMe;
            btnPhantomPlay.style.display = '';
            btnPhantomPlay.disabled = !canPhantom;
            if (canPhantom) {
                btnPhantomPlay.classList.add('active');
            } else {
                btnPhantomPlay.classList.remove('active');
            }
        } else {
            // 使用済み or PHANTOMでない → 非表示
            btnPhantomPlay.style.display = 'none';
        }
    }

    // 旧btnCheatは非表示のまま
    const btn = $('btnCheat');
    if (btn) btn.disabled = true;
}

// イカサマ使用（旧ボタン・互換のため残す）
$('btnCheat').addEventListener('click', () => {
    const state = myState.gameState;
    if (!state || state.myCheatUsed) return;

    if (state.myCheat === 'PHANTOM') {
        handlePhantom(state);
    } else if (state.myCheat === 'CANCEL') {
        handleCancel();
    }
});

// 「出す」横PHANTOMボタン
$('btnPhantomPlay').addEventListener('click', () => {
    const state = myState.gameState;
    if (!state || state.myCheatUsed) return;
    handlePhantom(state);
});

function handlePhantom(state) {
    if (state.currentPhase !== 'play' || !state.players[state.currentTurn].isMe) return;
    if (myState.selectedCardIndex < 0 || myState.selectedDeclareNumber < 0) {
        showJudge('カードと宣言数字を先に選んでください', 'trust-broken');
        return;
    }
    socket.emit('usePhantom', {
        cardIndex: myState.selectedCardIndex,
        declaredNumber: myState.selectedDeclareNumber
    });
    myState.selectedCardIndex = -1;
    myState.selectedDeclareNumber = -1;
}

function handleCancel() {
    socket.emit('respondCancel');
}

// デッキ情報
function renderDeckInfo(state) {
    $('deckInfo').textContent = `山札: ${state.deckCount}枚`;
}

// ===============================
// サーバーイベント
// ===============================

function showBotComment(playerName, type) {
    if (!myState.gameState) return;
    const p = myState.gameState.players.find(player => player.name === playerName);
    if (!p || !CHARACTERS[p.name] || p.isMe) return;

    const safeId = CHARACTERS[p.name];
    const bubble = $(`avatar-bubble-${safeId}`);
    const img = $(`avatar-img-${safeId}`);
    if (!bubble || !img) return;

    const phrases = BOT_COMMENTS[CHARACTERS[p.name]][type] || BOT_COMMENTS[CHARACTERS[p.name]]['normal'];
    const text = phrases[Math.floor(Math.random() * phrases.length)];

    bubble.textContent = text;
    bubble.classList.add('show');
    img.src = `images/${CHARACTERS[p.name]}_${type}.png`;

    if (bubble.hideTimeout) clearTimeout(bubble.hideTimeout);

    bubble.hideTimeout = setTimeout(() => {
        bubble.classList.remove('show');
        if (myState.gameState) {
            renderAvatars(myState.gameState); // 表情を元に戻す
        }
    }, 3000);
}

// ロングショット発動
socket.on('longshot', (data) => {
    SoundManager.playSE('longshot');
    const overlay = $('longshotOverlay');



    // 前回のタイマーが残っていればキャンセル
    if (longshotHideTimer) {
        clearTimeout(longshotHideTimer);
        longshotHideTimer = null;
    }

    // アニメーションリセット（display: none では offsetHeight が効かないため flex にしてからリセット）
    overlay.style.display = 'flex';
    overlay.style.animation = 'none';

    // 子要素のアニメーションもリセット
    const textEl = overlay.querySelector('.longshot-text');
    const subEl = overlay.querySelector('.longshot-sub');
    if (textEl) textEl.style.animation = 'none';
    if (subEl) subEl.style.animation = 'none';

    // 確実にブラウザにリセットを認識させるため、次の描画フレームでアニメーションを適用
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            overlay.style.animation = 'longshotFlash 2.5s ease-out forwards';
            if (textEl) textEl.style.animation = 'longshotTextGlow 0.5s ease-in-out infinite alternate';
            if (subEl) subEl.style.animation = 'longshotSubFade 1s 0.5s ease-out forwards';
        });
    });



    // 画面揺れ
    document.body.classList.remove('shake');
    document.body.offsetHeight; // reflow
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 500);

    showBotComment(data.declarer, 'smug');
    if (data.doubters) {
        const doubtersList = typeof data.doubters === 'string' ? data.doubters.split(', ') : data.doubters;
        doubtersList.forEach(d => showBotComment(d, 'shock'));
    }

    longshotHideTimer = setTimeout(() => {
        overlay.style.display = 'none';
        overlay.style.animation = 'none';
        longshotHideTimer = null;
    }, 3000);
});

// LONGSHOTオーバーレイの手動閉じるボタン
$('btnCloseLongshot').addEventListener('click', () => {
    const overlay = $('longshotOverlay');
    if (longshotHideTimer) { clearTimeout(longshotHideTimer); longshotHideTimer = null; }
    overlay.style.display = 'none';
    overlay.style.animation = 'none';
});

// CANCELポップアップの手動閉じるボタン
$('btnCloseCancelPopup').addEventListener('click', () => {
    $('cancelPopup').style.display = 'none';
});

// Trust / Doubt スタンプを各キャラ立ち絵に表示
// responses: [ { name, type } ]  type = 'trust' | 'doubt'
function showResponseStamps(responses) {
    if (!myState.gameState) return;
    responses.forEach(({ name, type }) => {
        const charKey = CHARACTERS[name];
        if (!charKey) return; // 人間プレイヤーはスキップ
        const container = $(`avatar-container-${charKey}`);
        if (!container) return;

        // 古いスタンプを削除
        container.querySelectorAll('.response-stamp').forEach(el => el.remove());

        const stamp = document.createElement('div');
        stamp.className = `response-stamp ${type}`;
        stamp.textContent = type === 'trust' ? 'Trust' : 'Doubt';
        container.appendChild(stamp);
    });
}

// 嘘を見抜いた
socket.on('busted', (data) => {
    SoundManager.playSE('busted');
    showJudge('BUSTED!', 'busted');
    showBotComment(data.declarer, 'shock');
    if (data.doubters) {
        const doubtersList = typeof data.doubters === 'string' ? data.doubters.split(', ') : data.doubters;
        doubtersList.forEach(d => showBotComment(d, 'smug'));
    }
    document.body.classList.remove('shake');
    document.body.offsetHeight; // reflow
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 500);
});

// 本当だった（疑った側にペナルティ）
socket.on('trustBroken', (data) => {
    SoundManager.playSE('trustBroken');
    showJudge('TRUST BROKEN...', 'trust-broken');
    showBotComment(data.declarer, 'smug');
    if (data.doubters) {
        const doubtersList = typeof data.doubters === 'string' ? data.doubters.split(', ') : data.doubters;
        doubtersList.forEach(d => showBotComment(d, 'shock'));
    }
});

// Phantom使用通知
socket.on('phantomUsed', (data) => {
    SoundManager.playSE('playCard'); // 汎用で鳴らす
    showJudge(`✨ ${data.playerName} が PHANTOM 発動！`, 'busted');
    showBotComment(data.playerName, 'smug');
});

// Phantomキャンセル通知
socket.on('phantomCancelled', (data) => {
    // data.cancellerNames はカンマ区切り文字列。個別に showBotComment へ渡す
    const cancellers = data.cancellerNames ? data.cancellerNames.split(', ') : [];
    if (data.isBluff) {
        SoundManager.playSE('busted');
        showJudge(`❌ CANCEL！ ${data.declarerName} の嘘が発覚！ 実際: ${data.actualCard.rankName}${data.actualCard.suit}`, 'busted');
        showBotComment(data.declarerName, 'shock');
        cancellers.forEach(name => showBotComment(name, 'smug'));
    } else {
        SoundManager.playSE('trustBroken');
        showJudge(`❌ CANCEL！ ${data.declarerName} は本当だった… ${data.actualCard.rankName}${data.actualCard.suit}`, 'trust-broken');
        showBotComment(data.declarerName, 'smug');
        cancellers.forEach(name => showBotComment(name, 'shock'));
    }
});

// ゲーム終了
socket.on('gameOver', (data) => {
    SoundManager.stopBGM();
    stopCountdown();
    const overlay = $('resultOverlay');
    const title = $('resultTitle');
    const sub = $('resultSub');

    if (data.winner) {
        const isMe = data.winner === myState.name;
        if (isMe) SoundManager.playSE('win');
        else SoundManager.playSE('lose');

        title.textContent = isMe ? 'YOU WIN!' : `${data.winner} WIN!`;
        title.style.color = isMe ? 'var(--gold-bright)' : 'var(--crimson-bright)';

        if (data.isCleanWin) {
            sub.textContent = '✨ CLEAN WIN — No Cheats Used ✨';
            sub.style.color = 'var(--gold)';
        } else {
            sub.textContent = isMe ? 'お見事！' : '次は勝つ…！';
            sub.style.color = 'var(--text-secondary)';
        }
    } else {
        title.textContent = 'DRAW';
        title.style.color = 'var(--text-secondary)';
        sub.textContent = '全員脱落…';
    }

    overlay.style.display = 'flex';

    $('btnRematch').style.display = myState.isHost ? 'block' : 'none';
});

$('btnRematch').addEventListener('click', () => {
    socket.emit('rematch');
});

$('btnBackToLobby').addEventListener('click', () => {
    $('resultOverlay').style.display = 'none';
    showScreen('lobby');
    // リロードして状態リセット
    location.reload();
});

socket.on('rematchReady', () => {
    $('resultOverlay').style.display = 'none';
    if (myState.isHost) {
        socket.emit('startGame');
    }
});

// 判定演出
function showJudge(text, type) {
    const overlay = $('judgeOverlay');
    const judgeText = $('judgeText');

    judgeText.textContent = text;
    judgeText.className = `judge-text judge-${type}`;

    overlay.style.display = 'flex';

    // アニメーションリセット
    judgeText.style.animation = 'none';
    judgeText.offsetHeight;
    judgeText.style.animation = '';

    setTimeout(() => {
        overlay.style.display = 'none';
    }, 2500);
}

// プレイヤー参加/退出
socket.on('playerJoined', (data) => {
    if (screens.waiting.classList.contains('active')) {
        const list = $('playerList');
        const item = document.createElement('div');
        item.className = 'player-list-item';
        item.textContent = data.playerName;
        list.appendChild(item);

        if (myState.isHost && data.playerCount >= 2) {
            $('btnStart').style.display = 'block';
        }
    }
});

socket.on('playerLeft', (data) => {
    // 待機室でプレイヤーが退出
});

// 切断時
socket.on('disconnect', () => {
    showJudge('接続が切れました', 'trust-broken');
    setTimeout(() => location.reload(), 2000);
});

// 初期化
SoundManager.init();
