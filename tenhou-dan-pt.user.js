// ==UserScript==
// @name         天鳳 観戦欄 段位pt表示
// @namespace    https://github.com/munemiti-fukuda/
// @author       munemiti-fukuda
// @homepage     https://github.com/munemiti-fukuda/tenhou-dan-pt
// @version      0.8
// @description  観戦一覧の段位の横に、nodocchiの段位ランキングから段位ptを表示する(天鳳位は非表示)
// @match        https://tenhou.net/3/*
// @match        https://tenhou.net/4/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      nodocchi.moe
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/munemiti-fukuda/tenhou-dan-pt/main/tenhou-dan-pt.user.js
// @downloadURL  https://raw.githubusercontent.com/munemiti-fukuda/tenhou-dan-pt/main/tenhou-dan-pt.user.js
// ==/UserScript==

(function () {
  'use strict';

  const RG = 180;                          // APIのrgパラメータ(ページが使っていた値)
  const TTL = 60 * 60 * 1000;              // この時間を過ぎたら裏で取り直す(1時間)
  const RETRY_BASE = 60 * 1000;            // 失敗時の最初の待ち時間(以後2倍ずつ増える)
  const RETRY_MAX = 30 * 60 * 1000;        // 失敗時の待ち時間の上限
  const MAX_AGE = 24 * 60 * 60 * 1000;     // これより古い保存データは使わない
  const LOCK_MS = 30 * 1000;               // 他のタブが取得中とみなす時間
  const MARK = 'th-pt';
  const KEY = 'th-pt-cache3';              // 旧版のキャッシュは使わない
  const LOCK_KEY = 'th-pt-lock';
  const GRADE_TENHOUI = 20;                // APIで天鳳位を表すgrade(2200pt固定なので表示しない)

  // ptを表示する最低段位(APIのgrade: 17=八段, 18=九段, 19=十段, 20=天鳳位)
  // 九段以上だけ表示したい場合は 18 に変更してください
  const MIN_GRADE = 17;

  // /3/ は a.bt3 の中、/4/ は table.bt3 の中に段位の表示がある
  const DAN_SELECTOR = 'a.bt3 span[class^="dan"], table.bt3 span[class^="dan"]';

  const style = document.createElement('style');
  style.textContent = `.${MARK}{font-size:.6em;color:inherit;margin:0 .2em;white-space:nowrap;}`;
  (document.head || document.documentElement).appendChild(style);

  // data[n] = { time, map: Map(名前 -> {pt, grade}) }  (n は 3 か 4)
  const data = { 3: null, 4: null };
  const state = {
    3: { loading: false, retryAt: 0, fails: 0 },
    4: { loading: false, retryAt: 0, fails: 0 },
  };

  // 保存データを読み込む(開き直したときや、他のタブが取得したときにも使う)
  // 返り値: 手元のデータがTTL以内ならtrue
  function syncFromStorage(n) {
    try {
      const saved = JSON.parse(GM_getValue(KEY, 'null'));
      const e = saved && saved[n];
      if (e && (!data[n] || e.time > data[n].time) && Date.now() - e.time < MAX_AGE) {
        data[n] = { time: e.time, map: new Map(e.list) };
      }
    } catch (err) { /* 無視 */ }
    return !!data[n] && Date.now() - data[n].time <= TTL;
  }

  // 自分が取得した分(n)だけを保存データに上書きする(他のタブの分は消さない)
  function save(n) {
    try {
      let o = {};
      try { o = JSON.parse(GM_getValue(KEY, '{}')) || {}; } catch (err) { o = {}; }
      if (data[n]) o[n] = { time: data[n].time, list: Array.from(data[n].map) };
      GM_setValue(KEY, JSON.stringify(o));
    } catch (err) { /* 無視 */ }
  }

  // 複数タブが同時に取りに行かないようにする簡易ロック
  function tryLock(n) {
    try {
      const t = GM_getValue(LOCK_KEY + n, 0);
      if (Date.now() - t < LOCK_MS) return false;
      GM_setValue(LOCK_KEY + n, Date.now());
    } catch (err) { /* 無視 */ }
    return true;
  }

  [3, 4].forEach(syncFromStorage);

  function fail(n) {
    const s = state[n];
    s.fails += 1;
    const wait = Math.min(RETRY_BASE * Math.pow(2, s.fails - 1), RETRY_MAX);   // 60秒→120秒→…→最大30分
    s.retryAt = Date.now() + wait;
    s.loading = false;
    setTimeout(apply, wait + 100);   // DOMが静止していても再試行されるようにする
  }

  function fetchData(n) {
    const s = state[n];
    if (s.loading || Date.now() < s.retryAt) return;

    // 他のタブがすでに新しいデータを保存していれば、それを使う
    if (syncFromStorage(n)) {
      setTimeout(apply, 0);
      return;
    }

    // 他のタブが取得中なら、少し待ってから保存データを見に来る
    if (!tryLock(n)) {
      s.retryAt = Date.now() + 3000;
      setTimeout(apply, 3100);
      return;
    }

    s.loading = true;

    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://nodocchi.moe/api/graderank.php?playernum=${n}&orderby=0&rg=${RG}`,
      timeout: 20000,
      onload(res) {
        if (res.status !== 200) { fail(n); return; }   // 429/403/5xxなどは失敗として扱う
        try {
          const list = JSON.parse(res.responseText);
          if (!Array.isArray(list)) { fail(n); return; }
          const map = new Map();
          for (const p of list) {
            if (p.grade === GRADE_TENHOUI) continue;   // 天鳳位は表示しない
            map.set(p.username, { pt: p.pt, grade: p.grade });
          }
          data[n] = { time: Date.now(), map };
          save(n);
          s.fails = 0;
          s.retryAt = 0;
          s.loading = false;
          apply();
        } catch (e) {
          fail(n);
        }
      },
      onerror() { fail(n); },
      ontimeout() { fail(n); },
    });
  }

  let observer;

  function apply() {
    const dans = document.querySelectorAll(DAN_SELECTOR);
    if (!dans.length) return;

    observer.disconnect();   // 自分のDOM変更で再発火しないようにする
    try {
      dans.forEach((dan) => {
        const next = dan.nextElementSibling;
        if (!next || next.classList.contains(MARK)) return;   // 処理済み

        // この段位が属する表から、三麻か四麻かを判定する
        const table = dan.closest('table');
        const head = table && table.querySelector('td[colspan]');
        const m = head && head.textContent.match(/([三四])[般上特鳳]/);
        if (!m) return;                                      // 判定できなければ表示しない
        const n = m[1] === '三' ? 3 : 4;

        const d = data[n];
        if (!d || Date.now() - d.time > TTL) fetchData(n);   // 古ければ裏で更新
        if (!d) return;                                      // 手元にデータがなければ待つ

        const slash = next.nextElementSibling;               // R の次の「/」
        const nameNode = slash && slash.nextSibling;         // 名前のテキスト
        if (!nameNode || nameNode.nodeType !== 3) return;

        const info = d.map.get(nameNode.nodeValue.trim());
        if (!info) return;                                   // 天鳳位などデータにない人は何も出さない
        if (info.grade < MIN_GRADE) return;                  // 設定した段位未満は出さない

        const sp = document.createElement('span');
        sp.className = MARK;
        sp.textContent = info.pt + 'pt';
        sp.title = '推定段位pt(nodocchi.moe)';
        dan.after(sp);
      });
    } finally {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // 待たずにその場で処理する(描画前に呼ばれるので、一瞬消えるのを防げる)
  observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  apply();
})();
