import { ApiError } from '#shared/errors/api-error.js';

/** V-02: de outro destinatário, inexistente ou de outro tenant — nunca revela de quem é. */
export function notificationNotFound(): ApiError {
  return new ApiError('NOTIFICATION_NOT_FOUND');
}
