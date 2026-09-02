// nav border on scroll
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// scroll reveal
const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
  { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
);
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// copy install commands
const btn = document.getElementById('copyInstall');
if (btn) {
  btn.addEventListener('click', async () => {
    const raw = document.getElementById('installCmds').innerText;
    const cmds = raw
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => l.replace(/^\$\s*/, ''))
      .join('\n');
    try {
      await navigator.clipboard.writeText(cmds);
      const t = btn.textContent;
      btn.textContent = t === '复制' ? '已复制 ✓' : 'Copied ✓';
      setTimeout(() => (btn.textContent = t), 1800);
    } catch {
      btn.textContent = 'select ↑';
    }
  });
}
