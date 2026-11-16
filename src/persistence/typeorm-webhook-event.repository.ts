import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WebhookEventEntity } from './entities/webhook-event.entity';
import {
  IWebhookEventRepository,
  NewWebhookEvent,
  WebhookEvent,
  WebhookEventCompletion,
  WebhookProcessingResult,
} from './webhook-event';

const cut = (v: string | null | undefined, max: number): string | null =>
  v === undefined || v === null ? null : v.length > max ? v.slice(0, max) : v;

function toDomain(e: WebhookEventEntity): WebhookEvent {
  return {
    eventId: e.eventId,
    receivedAt: e.receivedAt,
    systemId: e.systemId,
    incomingStatus: e.incomingStatus,
    incomingCustomerId: e.incomingCustomerId,
    systemName: e.systemName,
    serviceType: e.serviceType,
    processingResult: e.processingResult as WebhookProcessingResult,
    detailCode: e.detailCode,
    kycCaseInternalId: e.kycCaseInternalId,
    processedAt: e.processedAt,
  };
}

/** TypeORM implementation of the callback audit. Stores safe technical fields only. */
@Injectable()
export class TypeOrmWebhookEventRepository implements IWebhookEventRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private get repo() {
    return this.dataSource.getRepository(WebhookEventEntity);
  }

  async start(input: NewWebhookEvent): Promise<WebhookEvent> {
    const row = this.repo.create({
      eventId: randomUUID(),
      receivedAt: input.receivedAt,
      systemId: cut(input.systemId, 100),
      incomingStatus: cut(input.incomingStatus, 50),
      incomingCustomerId: input.incomingCustomerId ?? null,
      systemName: cut(input.systemName, 100),
      serviceType: cut(input.serviceType, 100),
      processingResult: input.processingResult ?? 'PROCESSING',
      detailCode: cut(input.detailCode, 100),
      kycCaseInternalId: input.kycCaseInternalId ?? null,
      processedAt: null,
    });
    await this.repo.insert(row);
    return this.mustFind(row.eventId);
  }

  async complete(eventId: string, completion: WebhookEventCompletion): Promise<WebhookEvent> {
    await this.repo.update(eventId, {
      processingResult: completion.processingResult,
      detailCode: cut(completion.detailCode, 100),
      ...(completion.kycCaseInternalId !== undefined
        ? { kycCaseInternalId: completion.kycCaseInternalId }
        : {}),
      processedAt: new Date(),
    });
    return this.mustFind(eventId);
  }

  async findByEventId(eventId: string): Promise<WebhookEvent | null> {
    const e = await this.repo.findOne({ where: { eventId } });
    return e ? toDomain(e) : null;
  }

  async listBySystemId(systemId: string): Promise<WebhookEvent[]> {
    const rows = await this.repo.find({ where: { systemId }, order: { receivedAt: 'ASC' } });
    return rows.map(toDomain);
  }

  async listByKycCaseInternalId(kycCaseInternalId: string): Promise<WebhookEvent[]> {
    const rows = await this.repo.find({
      where: { kycCaseInternalId },
      order: { receivedAt: 'ASC' },
    });
    return rows.map(toDomain);
  }

  async listByResults(
    results: WebhookProcessingResult[],
    since: Date,
    limit: number,
  ): Promise<WebhookEvent[]> {
    if (results.length === 0) return [];
    const rows = await this.repo
      .createQueryBuilder('e')
      .where('e.processingResult IN (:...results)', { results })
      .andWhere('e.receivedAt >= :since', {
        since: since.toISOString().replace('T', ' ').slice(0, 19),
      })
      .orderBy('e.receivedAt', 'DESC')
      .limit(Math.min(Math.max(1, Math.floor(limit)), 500))
      .getMany();
    return rows.map(toDomain);
  }

  private async mustFind(eventId: string): Promise<WebhookEvent> {
    const found = await this.findByEventId(eventId);
    if (!found) throw new Error(`Webhook event not found: ${eventId}`);
    return found;
  }
}
