/** The single self-contained live-view page. Polls /state, click opens the agent's terminal. */
export const PAGE = `<!doctype html><html><head><meta charset="utf8"><title>butchr</title>
<style>
 body{background:#0d1117;color:#c9d1d9;font:14px/1.5 ui-monospace,monospace;margin:0;padding:24px}
 h1{font-size:16px;color:#8b949e;font-weight:600;margin:0 0 16px}
 .a{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid #21262d;border-radius:8px;margin:6px 0;cursor:pointer}
 .a:hover{background:#161b22;border-color:#30363d}
 .key{font-weight:600;color:#58a6ff;min-width:90px}
 .sum{flex:1;color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .st{font-size:12px;padding:2px 8px;border-radius:10px}
 .working{background:#132e1a;color:#3fb950}.blocked{background:#3a1e12;color:#e3893a}
 .idle{background:#1b2129;color:#8b949e}.done{background:#161b22;color:#6e7681}.unknown{background:#161b22;color:#6e7681}
 .empty{color:#6e7681;padding:24px 0}.hint{color:#6e7681;font-size:12px;margin-top:16px}
</style></head><body>
<h1>butchr — active agents</h1><div id="list"><div class="empty">loading…</div></div>
<div class="hint">click an agent to open its shell in a terminal · refreshes every 2s</div>
<script>
async function open(issue){ try{ await fetch('/agents/'+encodeURIComponent(issue)+'/open',{method:'POST'}); }catch(e){} }
async function tick(){
  let r; try{ r=await (await fetch('/state')).json(); }catch(e){ return; }
  const el=document.getElementById('list');
  if(!r.length){ el.innerHTML='<div class="empty">no active agents</div>'; return; }
  el.innerHTML=r.map(a=>'<div class="a" onclick="open('+JSON.stringify(a.issue)+')">'
    +'<span class="key">'+a.issue+'</span>'
    +'<span class="sum">'+(a.summary||'')+'</span>'
    +'<span class="st '+a.status+'">'+a.status+'</span></div>').join('');
}
tick(); setInterval(tick,2000);
</script></body></html>`;
