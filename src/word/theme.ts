import './word.css';

// Embed options via URL, e.g. /word?theme=dark&ink=%23ff3366&bg=%23000000
const params = new URLSearchParams(location.search);
const root = document.documentElement;
const theme = params.get('theme');
if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
const ink = params.get('ink');
if (ink) {
  root.style.setProperty('--ink', ink);
  root.style.setProperty('--accent', ink);
}
const bg = params.get('bg');
if (bg) root.style.setProperty('--page-bg', bg);
const font = params.get('font');
if (font) root.style.setProperty('--font', font);
