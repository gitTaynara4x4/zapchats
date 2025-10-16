(function () {
  try {
    var t = localStorage.getItem('theme');
    if (!t || t === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  } catch {}
})();
