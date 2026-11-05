// Roles are issued by the server database, never accepted from session claims.
export const USER_ROLES = Object.freeze(['administrator', 'editor', 'author', 'contributor', 'subscriber']);
export const allRoles = new Set(['owner', 'publisher', ...USER_ROLES]);
export function capabilities(role) {
  return { manageUsers: ['owner','administrator'].includes(role), edit: role !== 'subscriber' && allRoles.has(role),
    editAll: ['owner','administrator','editor','publisher'].includes(role),
    publish: ['owner','administrator','editor','publisher','author'].includes(role),
    upload: ['owner','administrator','editor','publisher','author'].includes(role) };
}
export const managedEmail = (value) => {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return s.length <= 254 && /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(s) && !s.includes('..') ? s : null;
};
