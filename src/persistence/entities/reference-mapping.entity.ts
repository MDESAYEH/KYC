import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** ORM mapping for table reference_mapping. Internal to the persistence module. */
@Entity('reference_mapping')
@Index('ux_reference_mapping_type_value', ['mappingType', 'flexcubeValue'], { unique: true })
export class ReferenceMappingEntity {
  @PrimaryGeneratedColumn({ name: 'id' })
  id: number;

  @Column({ name: 'mapping_type', type: 'varchar', length: 50 })
  mappingType: string;

  @Column({ name: 'flexcube_value', type: 'varchar', length: 200 })
  flexcubeValue: string;

  @Column({ name: 'reis_value', type: 'varchar', length: 200 })
  reisValue: string;

  @Column({ name: 'description', type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ name: 'active', type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
