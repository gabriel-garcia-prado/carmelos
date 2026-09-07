import type { ResultAsync } from 'neverthrow'
import type { DependencyError } from '#errors'

export type ConfirmationStatus = 'pending' | 'sent' | 'confirmed' | 'declined'

export type Confirmation = Readonly<{
  id: string
  eventId: string
  personId: string
  role: 'pizzaiolo' | 'crew' | 'fire_duty'
  messageBody: string
  status: ConfirmationStatus
  sentAt: Date | null
  confirmedAt: Date | null
}>

type ListDependencies = {
  fetchConfirmationsForDate: (date: string) => ResultAsync<readonly Confirmation[], DependencyError>
}

export const listConfirmationsForDate =
  (dependencies: ListDependencies) =>
  (date: string): ResultAsync<readonly Confirmation[], DependencyError> =>
    dependencies.fetchConfirmationsForDate(date)

type UpdateStatusDependencies = {
  saveStatus: (id: string, status: ConfirmationStatus) => ResultAsync<Confirmation, DependencyError>
}

export const updateConfirmationStatus =
  (dependencies: UpdateStatusDependencies) =>
  (input: Readonly<{ id: string; status: ConfirmationStatus }>): ResultAsync<Confirmation, DependencyError> =>
    dependencies.saveStatus(input.id, input.status)
