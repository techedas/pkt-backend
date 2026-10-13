import type { AppSettings } from '../../config/settingsDefaults';
import { AppError } from '../../utils/errors';
import { settingsService } from '../settings.service';

export function passwordPolicyErrors(password: string, policy: AppSettings['passwordPolicy']): string[] {
  const errors: string[] = [];
  if (password.length < policy.minLength) errors.push(`at least ${policy.minLength} characters`);
  if (policy.requireUppercase && !/[A-Z]/.test(password)) errors.push('an uppercase letter');
  if (policy.requireLowercase && !/[a-z]/.test(password)) errors.push('a lowercase letter');
  if (policy.requireNumber && !/\d/.test(password)) errors.push('a number');
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password)) errors.push('a special character');
  return errors;
}

export async function assertPasswordPolicy(password: string) {
  const policy = await settingsService.get('passwordPolicy');
  const errors = passwordPolicyErrors(password, policy);
  if (errors.length) {
    throw AppError.badRequest(`Password must contain ${errors.join(', ')}.`, 'WEAK_PASSWORD', errors);
  }
}
