/* global api, $, esc, md, viewEl, state */
// In-app guide. Content lives in help/help.md; each "## " heading is a section.

let helpSections = null;

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function loadHelp() {
  if (helpSections) return helpSections;
  const text = await api.getHelp();
  const parts = text.split(/^## /m);
  const intro = parts.shift();
  helpSections = parts.map((p) => {
    const nl = p.indexOf('\n');
    const title = p.slice(0, nl).trim();
    return { id: slug(title), title, body: p.slice(nl + 1), text: (title + ' ' + p).toLowerCase() };
  });
  helpSections.intro = intro.replace(/^# .*\n/, '');
  return helpSections;
}

async function renderHelp(section) {
  const sections = await loadHelp();
  if (state.view.name !== 'help') return;
  viewEl.innerHTML = `<div class="view-inner help">
    <div class="page-head"><div><h1>Help</h1><div class="sub">Everything you need to set up and run routines.</div></div></div>
    <div class="help-layout">
      <nav class="help-toc">
        <input type="search" id="help-search" placeholder="Search help" />
        ${sections.map((s) => `<a href="#" data-help-jump="${s.id}">${esc(s.title)}</a>`).join('')}
      </nav>
      <div class="help-body">
        <div class="markdown help-intro">${md(sections.intro)}</div>
        ${sections.map((s) => `<section class="help-section markdown" id="help-${s.id}"><h2>${esc(s.title)}</h2>${md(s.body)}</section>`).join('')}
        <div class="empty" id="help-none" hidden>No help topics match your search.</div>
      </div>
    </div>
  </div>`;

  $('#help-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    let shown = 0;
    for (const s of sections) {
      const hit = !q || s.text.includes(q);
      $(`#help-${s.id}`).hidden = !hit;
      $(`[data-help-jump="${s.id}"]`).classList.toggle('dim', !hit);
      if (hit) shown++;
    }
    $('.help-intro').hidden = Boolean(q);
    $('#help-none').hidden = shown > 0;
    viewEl.scrollTop = 0;
  });

  if (section) jumpTo(section);
}

function jumpTo(id) {
  const el = document.getElementById(`help-${id}`);
  if (el) viewEl.scrollTo({ top: el.offsetTop - 20, behavior: 'smooth' });
}

document.addEventListener('click', (e) => {
  const jump = e.target.closest('[data-help-jump]');
  if (jump) {
    e.preventDefault();
    return jumpTo(jump.dataset.helpJump);
  }
  // In-guide links like [Approvals](#permissions-and-approvals) and links from other screens.
  const a = e.target.closest('a[href^="#"]');
  if (a && a.getAttribute('href').length > 1 && state.view.name === 'help' && a.closest('.help-body')) {
    e.preventDefault();
    return jumpTo(a.getAttribute('href').slice(1));
  }
  const open = e.target.closest('[data-open-help]');
  if (open) {
    e.preventDefault();
    state.view = { name: 'help', section: open.dataset.openHelp };
    state.lastRenderKey = '';
    renderHelp(open.dataset.openHelp);
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.id === 'nav-help'));
  }
});
