export const OFFBOARDING_PLATFORM_ENUM = ['slack', 'google_workspace', 'github', 'jira', 'notion', 'figma'];
export const OFFBOARDING_STATUS_ENUM = ['active', 'pending_removal', 'deactivated'];

export function getEnumValues(openApi, propertyName) {
  const normalizedOpenApi = openApi.replace(/\r\n/g, '\n');
  const escapedProperty = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedProperty}:\\n(?:[ \\t]+.*\\n)*?[ \\t]+enum: \\[(.*?)\\]`, 'm');
  const match = normalizedOpenApi.match(pattern);

  return match
    ? match[1].split(',').map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
    : null;
}
