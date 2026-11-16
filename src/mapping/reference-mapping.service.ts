import { Inject, Injectable } from '@nestjs/common';
import {
  IReferenceMappingRepository,
  IReferenceMappingService,
  REFERENCE_MAPPING_REPOSITORY,
} from './mapping.interfaces';
import { ReferenceMappingType, UnmappedReferenceValueError } from './reference-mapping';

@Injectable()
export class ReferenceMappingService implements IReferenceMappingService {
  constructor(
    @Inject(REFERENCE_MAPPING_REPOSITORY) private readonly repository: IReferenceMappingRepository,
  ) {}

  async resolve(type: ReferenceMappingType, flexcubeValue: string): Promise<string> {
    const entry = await this.repository.findActive(type, flexcubeValue);
    // Explicit exact comparison: guards against case-insensitive database collations.
    if (!entry || !entry.active || entry.flexcubeValue !== flexcubeValue) {
      throw new UnmappedReferenceValueError(type, flexcubeValue);
    }
    return entry.reisValue;
  }
}
