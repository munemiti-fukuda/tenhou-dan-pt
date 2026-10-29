// ==UserScript==
// @name         天鳳 観戦欄 段位pt表示
// @namespace    https://github.com/munemiti-fukuda/
// @author       munemiti-fukuda
// @homepage     https://github.com/munemiti-fukuda/tenhou-dan-pt
// @version      0.6
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

  const RG = 180;               // APIのrgパラメータ(ページが使っていた値)
  const TTL = 5 * 60 * 1000;    // この時間を過ぎたら裏で取り直す
  const RETRY = 30 * 1000;      // 失敗時の再試行間隔
  const MAX_AGE = 24 * 60 * 60 * 1000;   // これより古い保存データは使わない
  const MARK = 'th-pt';
  const KEY = 'th-pt-cache3';   // 旧版のキャッシュは使わない
  const GRADE_TENHOUI = 20;     // APIで天鳳位を表すgrade(2200pt固定なので表示しない)

  // ptを表示する最低段位(APIのgrade: 17=八段, 18=九段, 19=十段, 20=天鳳位)
  // 八段から表示したい場合は 17 に変更してください
  const MIN_GRADE = 18;

  // /3/ は a.bt3 の中、/4/ は table.bt3 の中に段位の表示がある
  const DAN_SELECTOR = 'a.bt3 span[class^="dan"], table.bt3 span[class^="dan"]';

  const style = document.createElement('style');
  style.textContent = `.${MARK}{font-size:.6em;color:inherit;margin:0 .2em;white-space:nowrap;}`;
  (document.head || document.documentElement).appendChild(style);

  // data[n] = { time, map: Map(名前 -> pt) }  (n は 3 か 4)
  const data = { 3: null, 4: null };
  const state = { 3: { loading: false, retryAt: 0 }, 4: { loading: false, retryAt: 0 } };

  // 前回の結果を読み込む(開き直してもすぐ表示できるように)
  try {
    const saved = JSON.parse(GM_getValue(KEY, 'null'));
    if (saved) {
      [3, 4].forEach((n) => {
        if (saved[n] && Date.now() - saved[n].time < MAX_AGE) {
          data[n] = { time: saved[n].time, map: new Map(saved[n].list) };
        }
      });
    }
  } catch (e) { /* 無視 */ }

  function save() {
    try {
      const o = {};
      [3, 4].forEach((n) => {
        if (data[n]) o[n] = { time: data[n].time, list: Array.from(data[n].map) };
      });
      GM_setValue(KEY, JSON.stringify(o));
    } catch (e) { /* 無視 */ }
  }

  function fail(n) {
    const s = state[n];
    s.retryAt = Date.now() + RETRY;
    s.loading = false;
    setTimeout(apply, RETRY + 100);   // DOMが静止していても再試行されるようにする
  }

  function fetchData(n) {
    const s = state[n];
    if (s.loading || Date.now() < s.retryAt) return;
    s.loading = true;

    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://nodocchi.moe/api/graderank.php?playernum=${n}&orderby=0&rg=${RG}`,
      timeout: 20000,
      onload(res) {
        try {
          const list = JSON.parse(res.responseText);
          const map = new Map();
          for (const p of list) {
            if (p.grade === GRADE_TENHOUI) continue;   // 天鳳位は表示しない
            map.set(p.username, { pt: p.pt, grade: p.grade });
          }
          data[n] = { time: Date.now(), map };
          save();
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
