import {
  PROFILE_NAME_MAX,
  PROFILE_NAME_MIN,
  PROFILE_DENSITIES,
  PROFILE_THEMES,
  isBrazilianPhone,
} from '@contrataflow/validation';
import type { MyProfileDto, UpdateMyProfile } from '@contrataflow/validation';

/*
 * Modelo do formulário "Meu perfil" (US-098): rascunho em texto, validação com as mesmas regras do
 * `updateMyProfileSchema` da API (RN-IAM-109) e o corpo do `PATCH /me` só com o que mudou.
 */

export interface ProfileDraft {
  readonly name: string;
  readonly socialName: string;
  readonly phone: string;
  readonly density: string;
  readonly theme: string;
}

export type ProfileField = 'name' | 'socialName' | 'phone';
export type ProfileErrors = Partial<Record<ProfileField, ProfileField>>;

export function toDraft(profile: MyProfileDto): ProfileDraft {
  return {
    name: profile.name,
    socialName: profile.socialName ?? '',
    phone: profile.phone ?? '',
    density: profile.preferences.density,
    theme: profile.preferences.theme,
  };
}

function nameLengthOk(value: string): boolean {
  const length = value.trim().length;
  return length >= PROFILE_NAME_MIN && length <= PROFILE_NAME_MAX;
}

/** V-01: nome (obrigatório), nome social e telefone (opcionais, mas válidos quando preenchidos). */
export function validateDraft(draft: ProfileDraft): ProfileErrors {
  const errors: ProfileErrors = {};
  if (!nameLengthOk(draft.name)) errors.name = 'name';
  if (draft.socialName.trim() !== '' && !nameLengthOk(draft.socialName)) {
    errors.socialName = 'socialName';
  }
  if (draft.phone.trim() !== '' && !isBrazilianPhone(draft.phone.trim())) errors.phone = 'phone';
  return errors;
}

/** Corpo do `PATCH /me`: só os campos diferentes do perfil carregado (campo vazio → `null`). */
export function buildPatch(draft: ProfileDraft, profile: MyProfileDto): UpdateMyProfile {
  const patch: {
    name?: string;
    socialName?: string | null;
    phone?: string | null;
    preferences?: Record<string, string>;
  } = {};
  const name = draft.name.trim();
  if (name !== profile.name) patch.name = name;
  const socialName = draft.socialName.trim() === '' ? null : draft.socialName.trim();
  if (socialName !== profile.socialName) patch.socialName = socialName;
  const phone = draft.phone.trim() === '' ? null : draft.phone.trim();
  if (phone !== profile.phone) patch.phone = phone;
  const preferences: Record<string, string> = {};
  if (draft.density !== profile.preferences.density) preferences.density = draft.density;
  if (draft.theme !== profile.preferences.theme) preferences.theme = draft.theme;
  if (Object.keys(preferences).length > 0) patch.preferences = preferences;
  return patch;
}

export function isDirty(patch: UpdateMyProfile): boolean {
  return Object.keys(patch).length > 0;
}

/** Nome exibido na interface: o social, se houver (RN-IAM-110). */
export function displayNameOf(profile: Pick<MyProfileDto, 'name' | 'socialName'>): string {
  const social = profile.socialName?.trim();
  return social === undefined || social === '' ? profile.name : social;
}

export { PROFILE_DENSITIES, PROFILE_THEMES };
