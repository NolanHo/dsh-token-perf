/**
 * Style tag for the dsh-token-perf settings page.
 *
 * The client module system has no CSS build step, so the rules live in one
 * string installed as a `<style data-plugin-css="dsh-token-perf">` element by
 * the activation effect (never a CSS import, which the bundle purity gate
 * rejects). Selectors are literal and scoped by {@link PREFIX}; every color,
 * border, and font rides the shared `--dsw-*` tokens so the page follows the
 * active theme.
 * @module dsh-token-perf/client/styles
 */

/** Class-name prefix; every selector this plugin owns starts with it. */
export const PREFIX = 'dstp'

/** `data-plugin-css` ownership key: identifies the one style tag this plugin installs. */
export const STYLE_ID = 'dsh-token-perf'

const RULES = `
.${PREFIX}-page {
  display: flex; flex-direction: column; gap: 14px;
  width: 100%; max-width: 1100px;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
  font-size: var(--dsw-font-xs-13, 13px);
  line-height: 20px;
}
.${PREFIX}-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.${PREFIX}-subtitle { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-heading { display: flex; flex-direction: column; }

.${PREFIX}-header {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.${PREFIX}-nav { display: flex; align-items: center; gap: 6px; }
.${PREFIX}-dateForm { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.${PREFIX}-label { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-input {
  width: 132px; height: 28px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 6px;
  padding: 0 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.${PREFIX}-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.${PREFIX}-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-meta { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12, 12px); }
.${PREFIX}-invalid { margin: 0; color: var(--dsw-alias-state-error-primary); }

.${PREFIX}-button {
  height: 28px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 6px;
  padding: 0 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.${PREFIX}-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-buttonActive {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}

.${PREFIX}-body { display: flex; flex-direction: column; gap: 16px; }
.${PREFIX}-section {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.${PREFIX}-sectionTitle { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
.${PREFIX}-note { margin: 0; color: var(--dsw-alias-label-tertiary); }

.${PREFIX}-cards {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px; margin: 0; padding: 0; list-style: none;
}
.${PREFIX}-card {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.${PREFIX}-cardTitle { color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12, 12px); }
.${PREFIX}-cardValue { font-size: 18px; line-height: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.${PREFIX}-cardDetail { color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xxs-12, 12px); font-variant-numeric: tabular-nums; }

.${PREFIX}-bar {
  display: flex; width: 100%; height: 12px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-3);
}
.${PREFIX}-barSegment { display: block; height: 100%; min-width: 1px; }
.${PREFIX}-barSegment[data-bucket='input'] { background: var(--dsw-alias-state-business-primary); }
.${PREFIX}-barSegment[data-bucket='output'] { background: var(--dsw-alias-state-success-primary); }
.${PREFIX}-barSegment[data-bucket='cacheRead'] { background: var(--dsw-alias-brand-primary); }
.${PREFIX}-barSegment[data-bucket='cacheWrite'] { background: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-barSegment[data-bucket='reasoning'] { background: var(--dsw-alias-state-error-primary); }
.${PREFIX}-barEmpty { background: var(--dsw-alias-border-l2); }

.${PREFIX}-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.${PREFIX}-row { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-rowLabel { flex: 1; min-width: 0; }
.${PREFIX}-rowValue { font-variant-numeric: tabular-nums; }
.${PREFIX}-rowShare { width: 64px; text-align: right; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.${PREFIX}-rowLabel[data-bucket]::before {
  content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 6px;
  border-radius: 2px; background: var(--dsw-alias-border-l2); vertical-align: middle;
}
.${PREFIX}-rowLabel[data-bucket='input']::before { background: var(--dsw-alias-state-business-primary); }
.${PREFIX}-rowLabel[data-bucket='output']::before { background: var(--dsw-alias-state-success-primary); }
.${PREFIX}-rowLabel[data-bucket='cacheRead']::before { background: var(--dsw-alias-brand-primary); }
.${PREFIX}-rowLabel[data-bucket='cacheWrite']::before { background: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-rowLabel[data-bucket='reasoning']::before { background: var(--dsw-alias-state-error-primary); }

.${PREFIX}-chart {
  display: grid; grid-template-columns: repeat(24, minmax(0, 1fr));
  align-items: end; gap: 2px;
  height: 96px;
  padding-top: 4px;
}
.${PREFIX}-column { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
.${PREFIX}-columnFill {
  display: block; width: 100%; min-height: 1px;
  border-radius: 2px 2px 0 0;
  background: var(--dsw-alias-state-business-primary);
}
.${PREFIX}-columnAxis {
  margin-top: 4px; text-align: center;
  color: var(--dsw-alias-label-tertiary); font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.${PREFIX}-stats { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; list-style: none; }
.${PREFIX}-stats li { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

.${PREFIX}-breakdowns { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.${PREFIX}-breakdown { display: flex; flex-direction: column; gap: 4px; }
.${PREFIX}-breakdownTitle { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-breakdownBar { display: block; width: 96px; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-3); }
.${PREFIX}-breakdownFill { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-state-business-primary); }

.${PREFIX}-scroll { overflow-x: auto; }
.${PREFIX}-table { width: 100%; border-collapse: collapse; }
.${PREFIX}-table th, .${PREFIX}-table td {
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.${PREFIX}-table th { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.${PREFIX}-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-num { text-align: right; font-variant-numeric: tabular-nums; }
.${PREFIX}-titleCell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.${PREFIX}-route { font-family: var(--dsw-font-family, monospace); }
.${PREFIX}-id { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-models { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-badge {
  display: inline-block; padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 18px;
}
.${PREFIX}-badge[data-origin='subagent'] {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-brand-primary);
}
.${PREFIX}-sort { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.${PREFIX}-loading, .${PREFIX}-empty { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-empty {
  display: flex; flex-direction: column; gap: 6px;
  padding: 20px 12px;
  border: 0.5px dashed var(--dsw-alias-border-l3);
  border-radius: 10px;
}
.${PREFIX}-error {
  display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.${PREFIX}-error p { margin: 0; }
.${PREFIX}-errorDetail { color: var(--dsw-alias-label-tertiary); }
`

/**
 * Install the plugin's style tag once per activation.
 *
 * A tag left by an earlier activation — an HMR rebuild re-running this module —
 * is replaced rather than reused, so the newest activation owns the one tag in
 * the document and its disposer really removes it.
 * @returns a disposer removing the tag this call installed.
 */
export function injectStyles(): () => void {
  for (const stale of document.querySelectorAll(`style[data-plugin-css="${STYLE_ID}"]`)) stale.remove()
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-token-perf'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = RULES
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}
