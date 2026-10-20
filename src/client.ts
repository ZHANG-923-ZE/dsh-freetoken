// @ts-nocheck
/**
 * dsh-Freetoken — client 设置页（slots: settings.section），v3。
 *
 * 设计参考：shadcn/ui 的令牌化主题（背景/前景/边框/语义色分层）、
 * 现代 dashboard 的「状态优先 + 分组卡片 + 环形计量 + 分段导航」信息架构。
 * 图标为内联线性 SVG（不用外部资源；Lucide 风格，MIT）。
 * 视觉全部走宿主主题令牌 --dsw-alias-*，缺令牌时退回 --fb-* 并随系统深浅色切换。
 *
 * 约束：classic script（由 lib/client.js 直接加载），不能有顶层 import/export。
 */
window.__ModuleLoader__.load({
  id: "dsh-freetoken",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const h = react.createElement;
    const API = "/freetoken/api/status";
    const STYLE_ID = "dsh-freetoken-styles-v3";

    const CSS = `
.ft{--r-sm:10px;--r-md:14px;--r-lg:18px;--sp:4px;
  --fg:var(--dsw-alias-label-primary,#1d2129);--fg2:var(--dsw-alias-label-secondary,#4e5969);
  --fg3:var(--dsw-alias-label-tertiary,#86909c);
  --bg0:var(--dsw-alias-bg-layer-1,#f5f6f8);--bg1:var(--dsw-alias-bg-layer-2,#ffffff);
  --bg2:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#ffffff));
  --bd:var(--dsw-alias-border-l1,#e5e6eb);--bd2:var(--dsw-alias-border-l2,#d9dbe1);
  --accent:var(--dsw-alias-brand-primary,#3b6ef0);--accent2:var(--dsw-alias-brand-secondary,#7c5cff);
  --ok:var(--dsw-alias-state-success-primary,#18a058);--warn:var(--dsw-alias-state-warn-label,#b07d00);
  --err:var(--dsw-alias-state-error-primary,#d93025);--code:var(--dsw-alias-markdown-code-block,#f2f3f5);
  --mono:var(--dsw-alias-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
  color:var(--fg);background:var(--bg0);border-radius:var(--r-lg);
  font-family:var(--dsw-alias-font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif);
  font-size:13px;line-height:1.55;padding:24px 26px 28px;min-height:100%}
@media (prefers-color-scheme:dark){.ft{--fg:#e7e9ee;--fg2:#b4bac6;--fg3:#868d9c;--bg0:#151619;--bg1:#1d1f24;--bg2:#23262c;--bd:#2d3037;--bd2:#3a3e46;--code:#24272d;--ok:#4cc38a;--warn:#e0b252;--err:#ff6b6b}}
.ft *{box-sizing:border-box}
.ft-shell{max-width:1080px;margin:0 auto}
.ft-top{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.ft-mark{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;
  background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 6px 16px color-mix(in srgb,var(--accent) 28%,transparent)}
.ft-title{font-size:17px;font-weight:680;letter-spacing:-.01em;margin:0}
.ft-sub{margin:2px 0 0;color:var(--fg3);font-size:12px}
.ft-top-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.ft-pill{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;border:1px solid var(--bd);
  background:var(--bg1);font-size:11.5px;font-weight:650;letter-spacing:.01em;white-space:nowrap}
.ft-dot{width:7px;height:7px;border-radius:50%;background:var(--fg3);flex:0 0 auto}
.ft-pill.on{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 34%,var(--bd))}
.ft-pill.on .ft-dot{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 16%,transparent);animation:ftpulse 2.4s ease-in-out infinite}
.ft-pill.halt{color:var(--err);border-color:color-mix(in srgb,var(--err) 42%,var(--bd));background:color-mix(in srgb,var(--err) 7%,var(--bg1))}
.ft-pill.halt .ft-dot{background:var(--err)}
.ft-pill.off{color:var(--fg3)}
@keyframes ftpulse{0%,100%{opacity:1}50%{opacity:.45}}
.ft-iconbtn{width:32px;height:32px;border-radius:9px;border:1px solid var(--bd);background:var(--bg1);color:var(--fg2);
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.ft-iconbtn:hover{color:var(--fg);background:color-mix(in srgb,var(--fg) 6%,var(--bg1))}
.ft-iconbtn:focus-visible,.ft-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ft-tabs{display:inline-flex;gap:4px;padding:4px;border:1px solid var(--bd);border-radius:12px;background:var(--bg1);margin-bottom:18px}
.ft-tab{appearance:none;border:0;background:transparent;color:var(--fg2);padding:7px 15px;border-radius:9px;font-size:12.5px;
  font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.ft-tab:hover{color:var(--fg)}
.ft-tab[aria-selected="true"]{background:color-mix(in srgb,var(--accent) 12%,var(--bg1));color:var(--accent)}
.ft-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.ft-card{border:1px solid var(--bd);border-radius:var(--r-md);background:var(--bg1);padding:16px 17px;min-width:0}
.ft-card.pad-0{padding:0;overflow:hidden}
.ft-card-head{display:flex;align-items:center;gap:8px;margin-bottom:12px;color:var(--fg3)}
.ft-card-head svg{flex:0 0 auto;opacity:.9}
.ft-card-head h3{margin:0;font-size:11px;font-weight:680;letter-spacing:.09em;text-transform:uppercase}
.ft-hero{grid-column:1/-1;display:grid;grid-template-columns:1fr auto;gap:22px;align-items:center;
  padding:22px 24px;border-radius:var(--r-lg);border:1px solid var(--bd);position:relative;overflow:hidden;
  background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 7%,var(--bg1)),var(--bg1) 62%)}
.ft-hero::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(520px 200px at 100% 0%,color-mix(in srgb,var(--accent2) 14%,transparent),transparent 70%)}
.ft-hero-kicker{font-size:11px;font-weight:680;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
.ft-hero h2{margin:0 0 6px;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-.02em}
.ft-hero p{margin:0;color:var(--fg2);font-size:12.5px;max-width:52ch}
.ft-quick{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.ft-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:8px;border:1px solid var(--bd);
  background:var(--bg2);color:var(--fg2);font-size:11.5px;font-variant-numeric:tabular-nums}
.ft-chip b{color:var(--fg);font-weight:650}
.ft-ring{position:relative;width:118px;height:118px;display:flex;align-items:center;justify-content:center}
.ft-ring svg{transform:rotate(-90deg)}
.ft-ring-c{position:absolute;text-align:center;line-height:1.15}
.ft-ring-c b{display:block;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.ft-ring-c span{font-size:10.5px;color:var(--fg3);letter-spacing:.04em}
.ft-banner{display:flex;gap:12px;align-items:flex-start;padding:13px 15px;border-radius:var(--r-md);border:1px solid var(--bd);
  margin-bottom:14px;background:var(--bg1)}
.ft-banner.err{border-color:color-mix(in srgb,var(--err) 38%,var(--bd));background:color-mix(in srgb,var(--err) 6%,var(--bg1))}
.ft-banner.warn{border-color:color-mix(in srgb,var(--warn) 40%,var(--bd));background:color-mix(in srgb,var(--warn) 7%,var(--bg1))}
.ft-banner .bi{flex:0 0 auto;color:var(--err);margin-top:1px}
.ft-banner.warn .bi{color:var(--warn)}
.ft-banner b{display:block;font-size:13px;margin-bottom:2px}
.ft-banner span{color:var(--fg2);font-size:12.5px}
.ft-rows{display:flex;flex-direction:column;gap:7px}
.ft-row{display:flex;align-items:baseline;justify-content:space-between;gap:14px;min-width:0}
.ft-row .k{color:var(--fg2);font-size:12.5px;flex:0 0 auto;display:inline-flex;align-items:center;gap:6px}
.ft-row .v{color:var(--fg);font-size:12.5px;font-variant-numeric:tabular-nums;text-align:right;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ft-row .v.mono{font-family:var(--mono);font-size:11px;color:var(--fg2)}
.ft-row .v.ok{color:var(--ok)}.ft-row .v.warn{color:var(--warn)}.ft-row .v.err{color:var(--err)}.ft-row .v.muted{color:var(--fg3)}
.ft-copy{appearance:none;border:0;background:transparent;color:var(--fg3);cursor:pointer;padding:0 0 0 2px;display:inline-flex}
.ft-copy:hover{color:var(--accent)}
.ft-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.ft-tile{border:1px solid var(--bd);border-radius:var(--r-sm);background:var(--bg2);padding:11px 12px;min-width:0}
.ft-tile em{display:flex;align-items:center;gap:5px;font-style:normal;color:var(--fg3);font-size:11px;margin-bottom:4px}
.ft-tile strong{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.ft-tile small{display:block;color:var(--fg3);font-size:10.5px;margin-top:2px}
.ft-bar{height:6px;border-radius:999px;background:var(--code);overflow:hidden;margin-top:10px}
.ft-bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .5s ease}
.ft-list{display:flex;flex-direction:column;gap:8px}
.ft-item{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--bd);border-radius:var(--r-sm);background:var(--bg2)}
.ft-item .ii{flex:0 0 auto;color:var(--fg3);margin-top:1px}
.ft-item b{display:block;font-size:12.5px;font-weight:620}
.ft-item span{display:block;color:var(--fg3);font-size:11.5px;margin-top:1px;word-break:break-word}
.ft-chips{display:flex;flex-wrap:wrap;gap:6px}
.ft-tag{font-family:var(--mono);font-size:10.5px;padding:3px 8px;border-radius:7px;background:var(--code);color:var(--fg2);border:1px solid var(--bd)}
.ft-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;color:var(--fg3);font-size:11px}
.ft-btn{appearance:none;border:1px solid var(--bd2);background:var(--bg1);color:var(--fg);padding:7px 13px;border-radius:9px;
  font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.ft-btn:hover{background:color-mix(in srgb,var(--fg) 6%,var(--bg1))}
.ft-empty{padding:40px 22px;text-align:center;color:var(--fg2);border:1px dashed var(--bd2);border-radius:var(--r-lg);background:var(--bg1)}
.ft-empty b{display:block;color:var(--fg);font-size:15px;margin-bottom:6px}
.ft-skel{border-radius:var(--r-md);background:linear-gradient(90deg,var(--bg1) 25%,var(--bg2) 37%,var(--bg1) 63%);
  background-size:400% 100%;animation:ftsheen 1.3s ease infinite;height:88px}
@keyframes ftsheen{0%{background-position:100% 50%}100%{background-position:0 50%}}
@media (max-width:720px){.ft{padding:18px 16px 22px}.ft-hero{grid-template-columns:1fr}.ft-ring{margin:4px auto 0}.ft-title{font-size:16px}}
`;
    function installStyles() {
      try {
        if (document.getElementById(STYLE_ID)) return;
        const el = document.createElement("style");
        el.id = STYLE_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
      } catch {}
    }

    const ICONS = {
      spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
      shield: "M12 3l7 3v6c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6z",
      user: "M20 21a8 8 0 10-16 0M12 11a4 4 0 100-8 4 4 0 000 8z",
      globe: "M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2c2.5 2.5 4 6 4 10s-1.5 7.5-4 10c-2.5-2.5-4-6-4-10s1.5-7.5 4-10z",
      gauge: "M12 14l4-4M4.9 19a10 10 0 1114.2 0",
      alert: "M12 3l9.5 17H2.5zM12 9v5M12 17.2v.1",
      refresh: "M21 12a9 9 0 11-2.6-6.4M21 4v5h-5",
      copy: "M8 8h11v13H8zM5 16H3V3h13v2",
      clock: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 7v5l3 2",
      lock: "M6 11h12v10H6zM9 11V7a3 3 0 016 0v4",
      server: "M4 4h16v6H4zM4 14h16v6H4zM7 7h.1M7 17h.1",
      list: "M9 6h12M9 12h12M9 18h12M4 6h.1M4 12h.1M4 18h.1",
      moon: "M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z",
      timer: "M12 22a9 9 0 100-18 9 9 0 000 18zM12 8v4l2.5 1.5M9 2h6",
      activity: "M3 12h4l2.5-7 5 14 2.5-7h4",
      info: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 11v6M12 7.5v.1",
    };
    function Icon(props) {
      const d = ICONS[props.name] || ICONS.info;
      const size = props.size || 15;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: props.weight || 1.7, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true" }, h("path", { d }));
    }
    function copyText(text) {
      try { navigator.clipboard.writeText(String(text)); } catch {}
    }
    function fmtTime(ts) {
      if (typeof ts !== "number" || !Number.isFinite(ts)) return "—";
      try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
    }
    function ago(ts) {
      if (typeof ts !== "number" || !Number.isFinite(ts)) return "—";
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return s + " 秒前";
      if (s < 3600) return Math.round(s / 60) + " 分钟前";
      if (s < 86400) return Math.round(s / 3600) + " 小时前";
      return Math.round(s / 86400) + " 天前";
    }
    function dur(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
      const s = Math.round(ms / 1000);
      if (s < 60) return s + " 秒";
      const m = Math.floor(s / 60);
      if (m < 60) return m + " 分 " + (s % 60) + " 秒";
      const hr = Math.floor(m / 60);
      if (hr < 24) return hr + " 小时 " + (m % 60) + " 分";
      return Math.floor(hr / 24) + " 天 " + (hr % 24) + " 小时";
    }
    function until(ts) { return typeof ts === "number" && Number.isFinite(ts) ? Math.max(0, ts - Date.now()) : null; }

    function Row(props) {
      return h("div", { className: "ft-row" },
        h("span", { className: "k" }, props.icon ? h(Icon, { name: props.icon, size: 13 }) : null, props.k),
        h("span", { className: "v " + (props.tone || "") + (props.mono ? " mono" : "") },
          props.v == null || props.v === "" ? "—" : String(props.v),
          props.copy ? h("button", { className: "ft-copy", title: "复制", onClick: () => copyText(props.copy) }, h(Icon, { name: "copy", size: 12 })) : null));
    }
    function Card(props) {
      return h("section", { className: "ft-card" + (props.pad0 ? " pad-0" : "") + (props.wide ? " " : "") },
        props.title ? h("div", { className: "ft-card-head" }, props.icon ? h(Icon, { name: props.icon, size: 13 }) : null, h("h3", null, props.title)) : null,
        props.children);
    }
    function Tile(props) {
      return h("div", { className: "ft-tile" },
        h("em", null, props.icon ? h(Icon, { name: props.icon, size: 12 }) : null, props.label),
        h("strong", null, props.value),
        props.hint ? h("small", null, props.hint) : null);
    }
    function Ring(props) {
      const r = 46, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, props.pct || 0));
      return h("div", { className: "ft-ring" },
        h("svg", { width: 118, height: 118, viewBox: "0 0 118 118" },
          h("circle", { cx: 59, cy: 59, r, fill: "none", stroke: "var(--bd)", strokeWidth: 9 }),
          h("circle", { cx: 59, cy: 59, r, fill: "none", stroke: props.color || "var(--accent)", strokeWidth: 9,
            strokeDasharray: c, strokeDashoffset: c - (c * pct) / 100, strokeLinecap: "round" })),
        h("div", { className: "ft-ring-c" }, h("b", null, props.label), h("span", null, props.sub)));
    }
    function Banner(props) {
      return h("div", { className: "ft-banner " + props.tone },
        h("span", { className: "bi" }, h(Icon, { name: props.icon || "alert", size: 18 })),
        h("div", null, h("b", null, props.title), h("span", null, props.text)));
    }
    function Item(props) {
      return h("div", { className: "ft-item" },
        h("span", { className: "ii" }, h(Icon, { name: props.icon || "info", size: 14 })),
        h("div", null, h("b", null, props.title), h("span", null, props.text)));
    }

    function Panel() {
      const [state, setState] = react.useState({ phase: "loading", snap: null, error: null, at: 0 });
      const [, tick] = react.useState(0);
      const [tab, setTab] = react.useState("overview");

      react.useEffect(() => {
        installStyles();
        let alive = true, poll = null, timer = null;
        const stop = () => { if (poll !== null) { window.clearInterval(poll); poll = null; } };
        const load = async () => {
          try {
            const res = await fetch(API, { headers: { accept: "application/json" }, cache: "no-store" });
            const snap = await res.json();
            if (!alive) return;
            setState({ phase: snap && snap.enabled === false ? "disabled" : "ready", snap, error: null, at: Date.now() });
            if (!snap || snap.enabled === false) stop();
          } catch (error) {
            if (!alive) return;
            setState({ phase: "closed", snap: null, error: error && error.message ? error.message : String(error), at: Date.now() });
            stop();
          }
        };
        load();
        poll = window.setInterval(load, 3000);
        timer = window.setInterval(() => tick((v) => v + 1), 1000);
        return () => { alive = false; stop(); if (timer !== null) window.clearInterval(timer); };
      }, []);

      const snap = state.snap;
      if (state.phase === "loading") {
        return h("div", { className: "ft" }, h("div", { className: "ft-shell" },
          h("div", { className: "ft-top" },
            h("div", { className: "ft-mark" }, h(Icon, { name: "spark", size: 20 })),
            h("div", null, h("h1", { className: "ft-title" }, "dsh-Freetoken"), h("p", { className: "ft-sub" }, "DeepSeek 网页接入 · 本地插件"))),
          h("div", { className: "ft-grid" },
            h("div", { className: "ft-skel", style: { gridColumn: "1/-1", height: "132px" } }),
            h("div", { className: "ft-skel" }), h("div", { className: "ft-skel" }), h("div", { className: "ft-skel" }))));
      }
      if (state.phase !== "ready" || !snap) {
        return h("div", { className: "ft" }, h("div", { className: "ft-shell" },
          h("div", { className: "ft-top" },
            h("div", { className: "ft-mark" }, h(Icon, { name: "spark", size: 20 })),
            h("div", null, h("h1", { className: "ft-title" }, "dsh-Freetoken"), h("p", { className: "ft-sub" }, "DeepSeek 网页接入 · 本地插件")),
            h("div", { className: "ft-top-right" }, h("span", { className: "ft-pill off" }, h("i", { className: "ft-dot" }), "已关闭"))),
          h("div", { className: "ft-empty" }, h("b", null, "已关闭（未启用）"),
            "当前插件 enabled:false 或 host 未就绪；不注册 provider、不加载重模块、不发送请求。"),
          h("div", { className: "ft-foot" },
            h("span", null, state.error ? "host 状态不可用：" + state.error : "本面板不会轮询已关闭的插件"),
            h("button", { className: "ft-btn", onClick: () => location.reload() }, h(Icon, { name: "refresh", size: 13 }), "重新检测"))));
      }

      const halted = snap.safety && snap.safety.halted === true;
      const loggedIn = snap.login && snap.login.loggedIn === true;
      const silenceLeft = snap.rhythm ? Math.max(0, (snap.rhythm.silenceRemainingMs || 0) - (Date.now() - state.at)) : 0;
      const mutedLeft = snap.safety ? until(snap.safety.mutedUntil) : null;
      const today = snap.rhythm ? snap.rhythm.todayRequests || 0 : 0;
      const budget = snap.rhythm ? snap.rhythm.dailyBudget || 0 : 0;
      const pct = budget > 0 ? Math.min(100, Math.round((today / budget) * 100)) : 0;
      const metrics = snap.metrics || {};
      const lazy = Array.isArray(snap.lazyLoaded) ? snap.lazyLoaded : [];
      const lastFailure = snap.lastFailure;
      const lastBlock = snap.rhythm && snap.rhythm.lastBlock;
      const phaseText = silenceLeft > 0 ? "静默冷却中" : snap.phase === "sending" ? "正在发送" : "空闲待命";

      const pill = halted
        ? h("span", { className: "ft-pill halt" }, h("i", { className: "ft-dot" }), "已熔断 · 停止发送")
        : h("span", { className: "ft-pill on" }, h("i", { className: "ft-dot" }), "ENABLED");

      const tabs = [["overview", "概览", "gauge"], ["rhythm", "节奏与请求", "activity"], ["diag", "诊断", "server"]];
      const tabbar = h("div", { className: "ft-tabs", role: "tablist" },
        tabs.map((t) => h("button", { key: t[0], role: "tab", "aria-selected": tab === t[0] ? "true" : "false",
          className: "ft-tab", onClick: () => setTab(t[0]) }, h(Icon, { name: t[2], size: 13 }), t[1])));

      const hero = h("div", { className: "ft-hero" },
        h("div", null,
          h("div", { className: "ft-hero-kicker" }, "DeepSeek 网页 · 本地桥接"),
          h("h2", null, halted ? "已熔断，停止发送" : loggedIn ? "运行中" : "等待登录"),
          h("p", null, halted
            ? "检测到 mute/封禁 或人工熔断。所有请求在出网点之前被拒绝，重启也不会恢复，直到解除时间或 /freetoken logout。"
            : loggedIn ? "凭证已就绪；所有网页请求经 RhythmController 串行、抖动、静默与日预算约束。"
            : "尚未捕获凭证。执行 /freetoken login 拉起独立 Edge 窗口，登录后自动写入本地 auth.json。"),
          h("div", { className: "ft-quick" },
            h("span", { className: "ft-chip" }, h(Icon, { name: "clock", size: 12 }), "最近请求 ", h("b", null, snap.rhythm && snap.rhythm.lastRequestAt ? ago(snap.rhythm.lastRequestAt) : "—")),
            h("span", { className: "ft-chip" }, h(Icon, { name: "activity", size: 12 }), "相位 ", h("b", null, phaseText)),
            h("span", { className: "ft-chip" }, h(Icon, { name: "shield", size: 12 }), "今日 ", h("b", null, budget > 0 ? today + " / " + budget : String(today))))),
        h(Ring, { pct, label: budget > 0 ? pct + "%" : String(today), sub: budget > 0 ? "日预算" : "今日请求", color: halted ? "var(--err)" : pct >= 80 ? "var(--warn)" : "var(--accent)" }));

      const overview = h("div", { className: "ft-grid" },
        hero,
        h(Card, { title: "今日用量", icon: "gauge" },
          h("div", { className: "ft-tiles" },
            h(Tile, { label: "网页请求", value: metrics.requests || 0, icon: "activity", hint: "经节奏出口" }),
            h(Tile, { label: "标题节省", value: metrics.titleSaved || 0, icon: "spark", hint: "0 网页请求" }),
            h(Tile, { label: "队列", value: snap.queue ? snap.queue.pending + "/" + snap.queue.maxPending : "—", icon: "list", hint: "含在飞" })),
          budget > 0 ? h("div", { className: "ft-bar" }, h("i", { style: { width: pct + "%" } })) : null),
        h(Card, { title: "账号与身份", icon: "user" },
          h("div", { className: "ft-rows" },
            h(Row, { k: "登录", v: loggedIn ? "已登录" : "未登录", tone: loggedIn ? "ok" : "warn", icon: "user" }),
            h(Row, { k: "最近校验", v: snap.login && snap.login.lastVerifiedAt ? fmtTime(snap.login.lastVerifiedAt) : "—", icon: "clock" }),
            h(Row, { k: "deviceId", v: snap.identity && snap.identity.deviceId ? snap.identity.deviceId.slice(0, 13) + "…" : "—", mono: true, copy: snap.identity && snap.identity.deviceId }),
            h(Row, { k: "单实例", v: snap.identity && snap.identity.singleInstance ? "已启用" : "关闭", icon: "lock" }))),
        h(Card, { title: "风险与安全", icon: "shield" },
          h("div", { className: "ft-rows" },
            h(Row, { k: "熔断", v: halted ? "已熔断" : "正常", tone: halted ? "err" : "ok", icon: "shield" }),
            h(Row, { k: "mute 解除", v: snap.safety && snap.safety.mutedUntil ? fmtTime(snap.safety.mutedUntil) : "—", icon: "clock" }),
            h(Row, { k: "最小间隔", v: "15s + 2–5s 抖动", icon: "timer" }),
            h(Row, { k: "重试", v: snap.retry ? snap.retry.attempts + " 次 / 下次 " + (snap.retry.nextDelayMs ? dur(snap.retry.nextDelayMs) : "—") : "—", icon: "refresh" }),
            h(Row, { k: "最近失败", v: lastFailure ? lastFailure.code : "无", tone: lastFailure ? "err" : "ok", icon: "alert" }))),
        h(Card, { title: "锁与浏览器", icon: "globe" },
          h("div", { className: "ft-rows" },
            h(Row, { k: "浏览器", v: snap.browser && snap.browser.running ? "运行中 pid=" + (snap.browser.pid || "?") : "未运行（懒启动）", icon: "globe" }),
            h(Row, { k: "串行锁", v: snap.lock && snap.lock.held ? "持有 " + dur(snap.lock.heldMs) : "空闲", tone: snap.lock && snap.lock.held ? "warn" : "ok", icon: "lock" }),
            h(Row, { k: "后端", v: snap.identity && snap.identity.backend, icon: "server" }),
            h(Row, { k: "旁白来源", v: snap.narration && snap.narration.model ? "模型" : snap.narration && snap.narration.local ? "本地模板" : "—", icon: "spark" }))));

      const rhythm = h("div", { className: "ft-grid" },
        h(Card, { title: "静默倒计时", icon: "timer" },
          h("div", { style: { display: "flex", alignItems: "center", gap: "18px" } },
            h(Ring, { pct: silenceLeft > 0 && snap.rhythm ? Math.min(100, Math.round((silenceLeft / Math.max(1, snap.rhythm.silenceRemainingMs || silenceLeft)) * 100)) : 0,
              label: silenceLeft > 0 ? Math.ceil(silenceLeft / 1000) + "s" : "0s", sub: silenceLeft > 0 ? "剩余静默" : "无静默", color: silenceLeft > 0 ? "var(--warn)" : "var(--ok)" }),
            h("div", { className: "ft-rows", style: { flex: 1 } },
              h(Row, { k: "静默状态", v: silenceLeft > 0 ? "冷却中" : "未静默", tone: silenceLeft > 0 ? "warn" : "ok" }),
              h(Row, { k: "上次静默原因", v: lastBlock ? lastBlock.reason : "—" }),
              h(Row, { k: "最近拦截", v: lastBlock ? fmtTime(lastBlock.at) : "—" })))),
        h(Card, { title: "请求节奏", icon: "activity" },
          h("div", { className: "ft-rows" },
            h(Row, { k: "今日请求", v: budget > 0 ? today + " / " + budget : String(today), icon: "activity" }),
            h(Row, { k: "最近请求", v: snap.rhythm && snap.rhythm.lastRequestAt ? ago(snap.rhythm.lastRequestAt) : "—", icon: "clock" }),
            h(Row, { k: "距上次(ms)", v: snap.rhythm && snap.rhythm.msSinceLastRequest != null ? dur(snap.rhythm.msSinceLastRequest) : "—", mono: true }),
            h(Row, { k: "抖动区间", v: "2000–5000ms 对数正态", icon: "timer" }),
            h(Row, { k: "每 turn 上限", v: "2 次（超出只加长间隔）", icon: "gauge" })),
          h("div", { className: "ft-bar" }, h("i", { style: { width: pct + "%" } }))),
        h(Card, { title: "请求指标", icon: "gauge", wide: true },
          h("div", { className: "ft-tiles" },
            h(Tile, { label: "网页请求", value: metrics.requests || 0, icon: "activity" }),
            h(Tile, { label: "标题节省", value: metrics.titleSaved || 0, icon: "spark" }),
            h(Tile, { label: "单飞命中", value: metrics.coalesced || 0, icon: "copy" }),
            h(Tile, { label: "拆批", value: metrics.batchSplit || 0, icon: "list" }),
            h(Tile, { label: "部分失败", value: metrics.partialFailure || 0, icon: "alert" }),
            h(Tile, { label: "请求/轮中位", value: metrics.requestsPerTurnMedian || 0, icon: "clock" }))));

      const diag = h("div", { className: "ft-grid" },
        h(Card, { title: "会话与引擎", icon: "server" },
          h("div", { className: "ft-rows" },
            h(Row, { k: "启动", v: snap.started ? "已启动" : "未启动", tone: snap.started ? "ok" : "muted" }),
            h(Row, { k: "相位", v: snap.phase }),
            h(Row, { k: "队列", v: snap.queue ? snap.queue.pending + " / " + snap.queue.maxPending : "—" }),
            h(Row, { k: "锁持有者", v: snap.lock && snap.lock.heldBy ? snap.lock.heldBy : "—", mono: true }),
            h(Row, { k: "更新时间", v: fmtTime(snap.updatedAt) }))),
        h(Card, { title: "最近失败", icon: "alert" },
          lastFailure
            ? h("div", { className: "ft-list" },
                h(Item, { icon: "alert", title: lastFailure.code, text: lastFailure.message }),
                h(Item, { icon: "clock", title: "时间", text: fmtTime(lastFailure.at) + "（" + ago(lastFailure.at) + "）" }))
            : h("span", { style: { color: "var(--fg3)", fontSize: "12.5px" } }, "本轮没有失败记录")),
        h(Card, { title: "旁白 narration", icon: "spark" },
          h("div", { className: "ft-rows" },
            h(Row, { k: "模型旁白", v: snap.narration && snap.narration.model ? "有" : "—", tone: snap.narration && snap.narration.model ? "ok" : "" }),
            h(Row, { k: "本地模板", v: snap.narration && snap.narration.local ? "有" : "—" }),
            h(Row, { k: "去重抑制", v: snap.narration ? snap.narration.dedupeSuppressed : 0 })),
          snap.narration && (snap.narration.model || snap.narration.local)
            ? h(Item, { icon: "spark", title: "最近一条", text: snap.narration.model || snap.narration.local }) : null),
        h(Card, { title: "懒加载模块（" + lazy.length + "）", icon: "server", wide: true },
          lazy.length
            ? h("div", { className: "ft-chips" }, lazy.map((k) => h("span", { className: "ft-tag", key: k }, k)))
            : h("span", { style: { color: "var(--fg3)", fontSize: "12.5px" } }, "尚未加载任何重模块（enabled-idle 或关闭态）")));

      return h("div", { className: "ft" }, h("div", { className: "ft-shell" },
        h("div", { className: "ft-top" },
          h("div", { className: "ft-mark" }, h(Icon, { name: "spark", size: 20 })),
          h("div", null,
            h("h1", { className: "ft-title" }, "dsh-Freetoken"),
            h("p", { className: "ft-sub" }, "DeepSeek 网页接入 · 本地插件 · provider deepseek-web")),
          h("div", { className: "ft-top-right" }, pill,
            h("button", { className: "ft-iconbtn", title: "刷新", onClick: () => location.reload() }, h(Icon, { name: "refresh", size: 14 })))),
        halted ? h(Banner, { tone: "err", icon: "alert", title: "已熔断，停止发送请求",
          text: (snap.safety.haltReason || "检测到 mute/封禁") + (mutedLeft != null ? "；解除倒计时 " + dur(mutedLeft) : "；需人工 /freetoken logout 恢复") }) : null,
        !loggedIn ? h(Banner, { tone: "warn", icon: "info", title: "尚未登录",
          text: "执行 /freetoken login，在独立 Edge 窗口登录后自动捕获凭证（登录前会清空旧登录 profile）。" }) : null,
        tabbar,
        tab === "overview" ? overview : tab === "rhythm" ? rhythm : diag,
        h("div", { className: "ft-foot" },
          h("span", null, "GET /freetoken/api/status · 只读 · 无凭证 · 更新于 " + fmtTime(snap.updatedAt)),
          h("button", { className: "ft-btn", onClick: () => location.reload() }, h(Icon, { name: "refresh", size: 13 }), "刷新"))));
    }

    const inject = ["slots"];
    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "freetoken",
        order: 47,
        label: () => "dsh-Freetoken"
      }, () => react.createElement(Panel))), "freetoken: settings page");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});