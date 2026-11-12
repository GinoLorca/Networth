// Runs before first paint (a classic, blocking script): apply the chosen theme so the page never flashes.
// ?theme=paper|night forces a theme for this visit; otherwise the saved choice; otherwise the device decides.
(function () {
  var choice = null;
  try {
    var q = new URLSearchParams(location.search).get('theme');
    if (q === 'paper' || q === 'night') choice = q;
    else choice = localStorage.getItem('networth.theme');
  } catch (e) { choice = null; }
  var root = document.documentElement;
  if (choice === 'paper') root.setAttribute('data-theme', 'light');
  else if (choice === 'night') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
})();
