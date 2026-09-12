/**
 * Shared, widget-safe view of a tenant's branding settings.
 *
 * Used by the agent-only `GET/PATCH /tenants/me/settings` routes and by the
 * public `GET /widget/config` endpoint so the two stay in sync. Never exposes
 * the raw `settings` column or `widgetApiKey`.
 */
export const DEFAULT_WELCOME = 'Hi! How can we help?';
export const DEFAULT_BRAND_COLOR = '#2563eb';

/**
 * The stored `settings` JSON merged over defaults, narrowed to the three
 * branding fields the widget is allowed to see.
 */
export function normalizeSettings(tenant) {
  const settings = tenant.settings ?? {};
  return {
    displayName: settings.displayName ?? tenant.name,
    welcomeMessage: settings.welcomeMessage ?? DEFAULT_WELCOME,
    brandColor: settings.brandColor ?? DEFAULT_BRAND_COLOR,
  };
}

export default normalizeSettings;
