(function () {
    try {
      var root = document.documentElement;
      var saved =
        (window.AppTheme && typeof window.AppTheme.current === 'function'
          ? window.AppTheme.current()
          : (
              localStorage.getItem('zapschat_theme') ||
              localStorage.getItem('zc:theme') ||
              localStorage.getItem('theme') ||
              localStorage.getItem('valora_theme') ||
              'dark'
            )
        ) || 'dark';

      var isDark = String(saved).toLowerCase() === 'dark';
      root.classList.toggle('dark', isDark);
      root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    } catch (e) {}
  })();
