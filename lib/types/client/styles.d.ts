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
export declare const PREFIX = "dstp";
/** `data-plugin-css` ownership key: identifies the one style tag this plugin installs. */
export declare const STYLE_ID = "dsh-token-perf";
/**
 * Install the plugin's style tag once per activation.
 * @returns a disposer removing the tag this call installed.
 */
export declare function injectStyles(): () => void;
