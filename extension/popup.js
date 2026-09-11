/**
 * note連携ツール（ポップアップ）。
 *
 * ★このツールは「集めて送る」だけにしてある。
 *   どの Cookie を使うか・有効かどうかの判断は、すべてサーバー側で行う。
 *   拡張は顧客のパソコンに配られたら直せないが、サーバーは即日直せるため。
 */

/** 既定の接続先。提供元の指示があったときだけ画面から変更できる。 */
// ★接続先は焼き込まない。全員に同じものを配り、設定画面で1回入れてもらう。
//   焼き込む方式だと、例文のまま作っても成功してしまい気づけなかった（2026-08-30 実際に事故）。
const DEFAULT_ENDPOINT = '';

/** note のログインを保持している Cookie。これが無ければ連携は成立しない。 */
const SESSION_COOKIE = '_note_session_v5';

const $ = (id) => document.getElementById(id);

const el = {
  state: $('login-state'),
  stateText: $('login-text'),
  linkState: $('link-state'),
  linkText: $('link-text'),
  footer: $('footer-note'),
  openNote: $('open-note'),
  code: $('code'),
  connect: $('connect'),
  result: $('result'),
  endpoint: $('endpoint'),
  saveEndpoint: $('save-endpoint'),
};

// ── 接続先 ───────────────────────────────────────────
async function getEndpoint() {
  const { endpoint } = await chrome.storage.local.get('endpoint');
  return (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

// ── note のログイン確認 ───────────────────────────────
async function checkLogin() {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://note.com/', name: SESSION_COOKIE });
    setLoginState(Boolean(cookie && cookie.value));
  } catch (e) {
    // 権限が下りていないなど。押せば分かるので、ここでは止めない
    setLoginState(false, 'ログイン状態を確認できませんでした');
  }
}

function setLoginState(loggedIn, overrideText) {
  el.state.className = `state state--${loggedIn ? 'ok' : 'ng'}`;
  el.stateText.textContent = overrideText
    ?? (loggedIn ? 'note にログイン済みです' : 'note にログインしていません');
  el.openNote.hidden = loggedIn;
}

// ── 連携コードの入力補助 ─────────────────────────────
function formatCode(raw) {
  const s = raw.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

el.code.addEventListener('input', () => {
  const atEnd = el.code.selectionStart === el.code.value.length;
  el.code.value = formatCode(el.code.value);
  if (atEnd) el.code.setSelectionRange(el.code.value.length, el.code.value.length);
});

el.code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect();
});

// ── 表示 ─────────────────────────────────────────────
function showResult(kind, message) {
  el.result.hidden = false;
  el.result.className = `result result--${kind}`;
  el.result.textContent = message;
}

// ── 本体 ─────────────────────────────────────────────
async function connect() {
  const code = el.code.value.replace(/-/g, '');
  if (code.length < 8) {
    showResult('ng', 'LINE で受け取った連携コードを入力してください。');
    el.code.focus();
    return;
  }

  el.connect.disabled = true;
  el.connect.textContent = '連携しています…';
  el.result.hidden = true;

  try {
    // 1. note の Cookie を集める（何を使うかはサーバーが決める）
    const cookies = await chrome.cookies.getAll({ domain: 'note.com' });
    if (!cookies.some((c) => c.name === SESSION_COOKIE && c.value)) {
      showResult('ng', 'note にログインしていないようです。\nnote.com を開いてログインしてから、もう一度お試しください。');
      setLoginState(false);
      return;
    }

    // 2. サーバーへ渡す
    const endpoint = await getEndpoint();
    const res = await fetch(`${endpoint}/connect/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
        userAgent: navigator.userAgent,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) {
      // ★端末トークンを保存する。以後、裏方がこれで名乗って仕事を取りに来る
      if (data.deviceToken) {
        await chrome.storage.local.set({ deviceToken: data.deviceToken, urlname: data.urlname });
      }
      showResult('ok',
        `連携できました。\n投稿先: ${data.nickname || ''}（@${data.urlname}）\n\n` +
        (data.executesLocally
          ? 'note への投稿は、このパソコンから行います。\n' +
            'Chrome を開いていれば、あとは LINE だけで完結します。'
          : 'LINE に戻って、そのまま記事を作れます。'));
      el.code.value = '';
      await showLinkState();
      // 待っている記事があればすぐ拾いに行く
      chrome.runtime.sendMessage({ type: 'poll-now' }).catch(() => {});
      return;
    }

    showResult('ng', data.message || `連携できませんでした（エラー ${res.status}）。`);
  } catch (e) {
    showResult('ng',
      'サーバーに接続できませんでした。\n' +
      'インターネットにつながっているかご確認のうえ、もう一度お試しください。');
    console.error(e);
  } finally {
    el.connect.disabled = false;
    el.connect.textContent = 'note と連携する';
  }
}

el.connect.addEventListener('click', connect);

el.openNote.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://note.com/login' });
  window.close();
});

el.saveEndpoint.addEventListener('click', async () => {
  const value = el.endpoint.value.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s]+$/.test(value)) {
    showResult('ng', 'https:// から始まるURLを入力してください。');
    return;
  }

  // ★接続先を焼き込むのをやめたので、ここで「この1つだけ」の許可をもらう。
  //   広い許可（すべてのサイト）を最初から取らないための形。
  //   ボタンを押したときにしか許可は求められないので、この場所である必要がある。
  let origin;
  try {
    origin = `${new URL(value).origin}/*`;
  } catch {
    showResult('ng', 'URL の形が正しくありません。');
    return;
  }

  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      showResult('ng', 'この接続先へのアクセスが許可されませんでした。もう一度お試しください。');
      return;
    }
  } catch (e) {
    // workers.dev 以外は要求できない（manifest の optional_host_permissions の範囲外）
    showResult('ng', 'この接続先には対応していません。〇〇.workers.dev のURLをご確認ください。');
    return;
  }

  await chrome.storage.local.set({ endpoint: value });
  showResult('ok', '接続先を保存しました。');
});

// ── このパソコンとサーバーの連携状態 ─────────────────
async function showLinkState() {
  const { deviceToken, urlname } = await chrome.storage.local.get(['deviceToken', 'urlname']);
  const linked = Boolean(deviceToken);
  el.linkState.hidden = false;
  el.linkState.className = `state state--${linked ? 'ok' : 'ng'}`;
  el.linkText.textContent = linked
    ? `連携済み${urlname ? `（@${urlname}）` : ''}・このパソコンから投稿します`
    : '未連携です。LINE で「note連携」と送ってください';
  el.footer.textContent = linked
    ? 'note への投稿は、このパソコンの Chrome から行われます。ログイン情報はサーバーに保存されません。'
    : 'このツールは note のログイン情報だけを読み取ります。パスワードは読み取りません。';
}

// ── 起動時 ───────────────────────────────────────────
(async () => {
  el.endpoint.value = await getEndpoint();
  await Promise.all([checkLogin(), showLinkState()]);
  // 開いたついでに、待っている仕事がないか見に行く
  chrome.runtime.sendMessage({ type: 'poll-now' }).catch(() => {});
  el.code.focus();
})();
