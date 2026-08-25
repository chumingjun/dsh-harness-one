// 主题调色板：styles.css 的 CSS 变量是唯一事实源；React Flow 的 SVG 属性
// （marker/迷你图节点/背景点）不走 CSS 级联、解析不了 var()，需要真实色值时
// 经 getComputedStyle 现取。useThemePalette 监听 <html data-theme> 变化
// （宿主 dsh 经 wf1-theme postMessage 驱动），切换时自动重算。
import { useEffect, useMemo, useState } from 'react';

const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

export function useThemePalette() {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => {
    const styles = getComputedStyle(document.documentElement);
    const token = (name) => styles.getPropertyValue(name).trim();
    return {
      canvasDot: token('--canvas-dot'),
      minimapMask: token('--minimap-mask'),
      labelFill: token('--fg-muted'),
      labelBg: token('--bg-panel'),
      edge: {
        idle: token('--edge-idle'), success: token('--edge-success'), running: token('--edge-running'),
        error: token('--edge-error'), skipped: token('--edge-skipped'), canceled: token('--edge-idle'),
      },
      minimapNode: {
        agent: token('--type-agent'), input: token('--type-input'), script: token('--type-script'),
        condition: token('--type-condition'), http: token('--type-http'), output: token('--type-output'),
        note: token('--type-note'), unknown: token('--fg-faint'),
      },
    };
  }, [theme]);
}
