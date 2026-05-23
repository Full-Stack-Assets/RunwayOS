export const OFFBOARDING_PLATFORM_ENUM = ['slack', 'google_workspace', 'github', 'jira', 'notion', 'figma'];
export const OFFBOARDING_STATUS_ENUM = ['active', 'pending_removal', 'deactivated'];

export function getEnumValues(openApi, propertyName) {
  const escapedProperty = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedProperty}:\\r?\\n(?:[ \\t]+.*\\r?\\n)*?[ \\t]+enum: \\[(.*?)\\]`, 'm');
  const match = openApi.match(pattern);

  return match ? match[1].split(',').map((value) => value.trim()) : null;
}
