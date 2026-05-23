export const OFFBOARDING_PLATFORM_ENUM = [
  'slack',
  'google_workspace',
  'github',
  'jira',
  'notion',
  'figma',
  'microsoft_365',
  'okta',
  'asana',
  'linear',
  'zoom'
];
export const OFFBOARDING_STATUS_ENUM = ['active', 'pending_removal', 'deactivated'];

export function isOffboardingPlatform(value) {
  return OFFBOARDING_PLATFORM_ENUM.includes(value);
}

export function isOffboardingStatus(value) {
  return OFFBOARDING_STATUS_ENUM.includes(value);
}
