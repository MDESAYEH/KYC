import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** ORM mapping for table webhook_event (callback audit). Internal to the persistence module. */
@Entity('webhook_event')
@Index('ix_webhook_event_system_id', ['systemId'])
@Index('ix_webhook_event_case', ['kycCaseInternalId'])
export class WebhookEventEntity {
  @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 36 })
  eventId: string;

  @Column({ name: 'received_at', type: 'datetime' })
  receivedAt: Date;

  @Column({ name: 'system_id', type: 'varchar', length: 100, nullable: true })
  systemId: string | null;

  @Column({ name: 'incoming_status', type: 'varchar', length: 50, nullable: true })
  incomingStatus: string | null;

  @Column({ name: 'incoming_customer_id', type: 'integer', nullable: true })
  incomingCustomerId: number | null;

  @Column({ name: 'system_name', type: 'varchar', length: 100, nullable: true })
  systemName: string | null;

  @Column({ name: 'service_type', type: 'varchar', length: 100, nullable: true })
  serviceType: string | null;

  @Column({ name: 'processing_result', type: 'varchar', length: 30 })
  processingResult: string;

  @Column({ name: 'detail_code', type: 'varchar', length: 100, nullable: true })
  detailCode: string | null;

  @Column({ name: 'kyc_case_internal_id', type: 'varchar', length: 36, nullable: true })
  kycCaseInternalId: string | null;

  @Column({ name: 'processed_at', type: 'datetime', nullable: true })
  processedAt: Date | null;
}
