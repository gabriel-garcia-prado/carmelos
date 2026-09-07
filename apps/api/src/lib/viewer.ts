/**
 * Who is looking.
 *
 * The app was built for one operator, and most of it still is: the book, the
 * pay rates, the phone directory and the ops constants are Billy's. These
 * roles exist so the crew can be given a login that shows them their own
 * shifts without handing over the rest of the business.
 */
export type Role = 'owner' | 'pizzaiolo' | 'crew'

export const ROLES: readonly Role[] = ['owner', 'pizzaiolo', 'crew']

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value)

export type Viewer = Readonly<{
  role: Role
  /**
   * The crew-pool person this login belongs to. Null for the owner, who isn't
   * in the pool. A pizzaiolo or crew login without one can't be shown "their"
   * events, because there is no-one for them to be — and the safe reading of
   * that is nothing rather than everything.
   */
  personId: string | null
}>

export const isOwner = (viewer: Viewer): boolean => viewer.role === 'owner'

/**
 * Reads a role off a session user.
 *
 * Anything unrecognised — a missing column on an old row, a value typed
 * straight into the database — resolves to `crew`, the least that can be
 * seen. Failing open here would mean a typo grants the whole book.
 */
export const roleFrom = (value: unknown): Role => (isRole(value) ? value : 'crew')
