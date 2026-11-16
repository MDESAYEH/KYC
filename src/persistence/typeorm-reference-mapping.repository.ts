import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IReferenceMappingRepository } from '../mapping/mapping.interfaces';
import {
  assertValidMappingInput,
  ReferenceMappingEntry,
  ReferenceMappingInput,
  ReferenceMappingType,
  UnmappedReferenceValueError,
} from '../mapping/reference-mapping';
import { ReferenceMappingEntity } from './entities/reference-mapping.entity';

function toDomain(e: ReferenceMappingEntity): ReferenceMappingEntry {
  return {
    id: e.id,
    mappingType: e.mappingType as ReferenceMappingType,
    flexcubeValue: e.flexcubeValue,
    reisValue: e.reisValue,
    description: e.description,
    // Some drivers return 0/1 for booleans.
    active: Boolean(e.active),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** TypeORM implementation. Lookups use exact (case-sensitive, untrimmed) equality. */
@Injectable()
export class TypeOrmReferenceMappingRepository implements IReferenceMappingRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private get repo() {
    return this.dataSource.getRepository(ReferenceMappingEntity);
  }

  async findActive(
    type: ReferenceMappingType,
    flexcubeValue: string,
  ): Promise<ReferenceMappingEntry | null> {
    const e = await this.repo.findOne({
      where: { mappingType: type, flexcubeValue, active: true },
    });
    return e ? toDomain(e) : null;
  }

  async find(
    type: ReferenceMappingType,
    flexcubeValue: string,
  ): Promise<ReferenceMappingEntry | null> {
    const e = await this.repo.findOne({ where: { mappingType: type, flexcubeValue } });
    return e ? toDomain(e) : null;
  }

  async upsert(input: ReferenceMappingInput): Promise<ReferenceMappingEntry> {
    assertValidMappingInput(input);
    const existing = await this.repo.findOne({
      where: { mappingType: input.mappingType, flexcubeValue: input.flexcubeValue },
    });
    if (existing) {
      await this.repo.update(existing.id, {
        reisValue: input.reisValue,
        description: input.description ?? null,
        active: input.active ?? true,
      });
    } else {
      await this.repo.insert({
        mappingType: input.mappingType,
        flexcubeValue: input.flexcubeValue,
        reisValue: input.reisValue,
        description: input.description ?? null,
        active: input.active ?? true,
      });
    }
    return this.mustFind(input.mappingType, input.flexcubeValue);
  }

  async setActive(
    type: ReferenceMappingType,
    flexcubeValue: string,
    active: boolean,
  ): Promise<ReferenceMappingEntry> {
    const existing = await this.repo.findOne({ where: { mappingType: type, flexcubeValue } });
    if (!existing) throw new UnmappedReferenceValueError(type, flexcubeValue);
    await this.repo.update(existing.id, { active });
    return this.mustFind(type, flexcubeValue);
  }

  async list(type?: ReferenceMappingType): Promise<ReferenceMappingEntry[]> {
    const rows = await this.repo.find({
      where: type ? { mappingType: type } : {},
      order: { mappingType: 'ASC', flexcubeValue: 'ASC' },
    });
    return rows.map(toDomain);
  }

  private async mustFind(
    type: ReferenceMappingType,
    flexcubeValue: string,
  ): Promise<ReferenceMappingEntry> {
    const found = await this.find(type, flexcubeValue);
    if (!found) throw new UnmappedReferenceValueError(type, flexcubeValue);
    return found;
  }
}
