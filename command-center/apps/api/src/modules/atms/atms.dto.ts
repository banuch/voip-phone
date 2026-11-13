import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsLatitude, IsLongitude, IsOptional, IsString, IsUrl, IsUUID,
  Matches, MaxLength, MinLength, ValidateIf,
} from 'class-validator';
import { DeviceHealth, DeviceRegistration } from '@wintek/shared';
import { PageQuery } from '../../common/http/pagination';

export class AtmListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() regionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() groupId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() operatorId?: string;
  @ApiPropertyOptional({ enum: Object.values(DeviceRegistration) }) @IsOptional() @IsIn(Object.values(DeviceRegistration)) registration?: string;
  @ApiPropertyOptional({ enum: Object.values(DeviceHealth) }) @IsOptional() @IsIn(Object.values(DeviceHealth)) health?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED', 'MAINTENANCE'] }) @IsOptional() @IsIn(['ACTIVE', 'DISABLED', 'MAINTENANCE']) status?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() inCall?: boolean;
  @ApiPropertyOptional({ description: 'Only ATMs the current operator is assigned to or covers' })
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() mine?: boolean;
  @ApiPropertyOptional({ description: 'Search ATM ID, name, city, site' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class CreateAtmDto {
  @ApiPropertyOptional({ description: 'Super administrators only' }) @IsOptional() @IsUUID() orgId?: string;
  @ApiProperty({ example: 'ATM-MH-00125' }) @IsString() @Matches(/^[A-Za-z0-9._-]{2,40}$/) atmCode: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name: string;
  @ApiProperty() @IsUUID() regionId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) site?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceModel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) serialNumber?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsUUID('all', { each: true }) @ArrayMaxSize(50) groupIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() primaryOperatorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() backupOperatorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) vmsCameraRef?: string;
  @ApiPropertyOptional({ description: 'https URL; {atmCode} and {cameraRef} are substituted' })
  @IsOptional() @ValidateIf((o) => o.vmsDeepLink !== '') @IsUrl({ protocols: ['https', 'http'], require_tld: false }) vmsDeepLink?: string;
  @ApiPropertyOptional({ default: true, description: 'Create the SIP identity and return its password once' })
  @IsOptional() @IsBoolean() provisionSip?: boolean;
}

export class UpdateAtmDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() regionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) site?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceModel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) serialNumber?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED', 'MAINTENANCE'] }) @IsOptional() @IsIn(['ACTIVE', 'DISABLED', 'MAINTENANCE']) status?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsUUID('all', { each: true }) @ArrayMaxSize(50) groupIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) vmsCameraRef?: string;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((o) => o.vmsDeepLink !== '') @IsUrl({ protocols: ['https', 'http'], require_tld: false }) vmsDeepLink?: string;
}

export class BulkAtmDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @IsUUID('all', { each: true }) atmIds: string[];
  @ApiProperty({ enum: ['SET_REGION', 'ADD_GROUP', 'REMOVE_GROUP', 'DISABLE', 'ENABLE', 'MAINTENANCE', 'SET_PRIMARY', 'SET_BACKUP'] })
  @IsIn(['SET_REGION', 'ADD_GROUP', 'REMOVE_GROUP', 'DISABLE', 'ENABLE', 'MAINTENANCE', 'SET_PRIMARY', 'SET_BACKUP'])
  action: string;
  @ApiPropertyOptional({ description: 'Region, group or operator id depending on action; null clears SET_PRIMARY/SET_BACKUP' })
  @IsOptional() @IsUUID() targetId?: string | null;
}

export class ImportQuery {
  @ApiPropertyOptional({ description: 'Validate only, write nothing' })
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() dryRun?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
}

export class ImportBody {
  @ApiProperty({
    description:
      'CSV with header: atm_code,name,region_code,state,city,site,address,latitude,longitude,device_model,serial_number,group_codes(;-separated),primary_username,backup_username,vms_camera_ref',
  })
  @IsString() @MaxLength(10_000_000) csv: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Boolean) @IsBoolean() provisionSip?: boolean;
}
