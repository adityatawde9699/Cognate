import { useEffect, useState } from 'react';

export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('cn_theme') || 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cn_theme', theme);
    // If there is a chart, you would update it here or in a separate hook
    window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  return { theme, toggleTheme };
}
