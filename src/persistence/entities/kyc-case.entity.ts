import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * ORM mapping for table kyc_case. Internal to the persistence module: application code only
 * sees the KycCase domain type via IKycCaseRepository. Schema changes go through migrations.
 */
@Entity('kyc_case')
export class KycCaseEntity {
  @PrimaryColumn({ name: 'internal_id', type: 'varchar', length: 36 })
  internalId: string;

  @Index('ux_kyc_case_kyc_ref_no', { unique: true })
  @Column({ name: 'kyc_ref_no', type: 'varchar', length: 100 })
  kycRefNo: string;

  @Index('ix_kyc_case_customer_no')
  @Column({ name: 'customer_no', type: 'varchar', length: 100, nullable: true })
  customerNo: string | null;

  @Index('ux_kyc_case_reis_system_id', { unique: true })
  @Column({ name: 'reis_system_id', type: 'varchar', length: 100 })
  reisSystemId: string;

  @Column({ name: 'reis_customer_id', type: 'integer', nullable: true })
  reisCustomerId: number | null;

  @Column({ name: 'risk_calculation_id', type: 'varchar', length: 100, nullable: true })
  riskCalculationId: string | null;

  @Column({ name: 'reis_id', type: 'varchar', length: 100, nullable: true })
  reisId: string | null;

  @Column({ name: 'customer_type', type: 'varchar', length: 20 })
  customerType: string;

  @Column({ name: 'internal_request_status', type: 'varchar', length: 40 })
  internalRequestStatus: string;

  @Column({ name: 'reis_onboarding_status', type: 'varchar', length: 20, nullable: true })
  reisOnboardingStatus: string | null;

  @Column({ name: 'final_status', type: 'varchar', length: 20, nullable: true })
  finalStatus: string | null;

  @Column({ name: 'final_status_at', type: 'datetime', nullable: true })
  finalStatusAt: Date | null;

  @Column({ name: 'final_status_received_count', type: 'integer', default: 0 })
  finalStatusReceivedCount: number;

  @Column({ name: 'conflicting_final_status', type: 'varchar', length: 20, nullable: true })
  conflictingFinalStatus: string | null;

  @Column({ name: 'reis_instruction', type: 'varchar', length: 4000, nullable: true })
  reisInstruction: string | null;

  @Column({ name: 'reis_error_message', type: 'varchar', length: 4000, nullable: true })
  reisErrorMessage: string | null;

  @Column({ name: 'flexcube_update_status', type: 'varchar', length: 20, default: 'NOT_ATTEMPTED' })
  flexcubeUpdateStatus: string;

  @Column({ name: 'flexcube_update_error_code', type: 'varchar', length: 100, nullable: true })
  flexcubeUpdateErrorCode: string | null;

  @Column({ name: 'flexcube_update_error_message', type: 'varchar', length: 1000, nullable: true })
  flexcubeUpdateErrorMessage: string | null;

  @Column({ name: 'flexcube_updated_at', type: 'datetime', nullable: true })
  flexcubeUpdatedAt: Date | null;

  @Column({ name: 'flexcube_update_attempt_count', type: 'integer', default: 0 })
  flexcubeUpdateAttemptCount: number;

  @Column({ name: 'flexcube_last_attempt_at', type: 'datetime', nullable: true })
  flexcubeLastAttemptAt: Date | null;

  @Column({ name: 'seq_no', type: 'integer', default: 1 })
  seqNo: number;

  @Column({ name: 'retry_count', type: 'integer', default: 0 })
  retryCount: number;

  @Column({ name: 'last_error_code', type: 'varchar', length: 100, nullable: true })
  lastErrorCode: string | null;

  @Column({ name: 'last_error_message', type: 'varchar', length: 1000, nullable: true })
  lastErrorMessage: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
