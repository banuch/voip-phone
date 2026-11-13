import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Availability, Role, SELECTABLE_AVAILABILITY } from '@wintek/shared';
import { PageQuery } from '../../common/http/pagination';

export class OperatorListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() regionId?: string;
  @ApiPropertyOptional({ enum: Object.values(Availability) }) @IsOptional() @IsIn(Object.values(Availability)) availability?: string;
  @ApiPropertyOptional({ description: 'Search username or name' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class CreateOperatorDto {
  @ApiPropertyOptional({ description: 'Super administrators only' }) @IsOptional() @IsUUID() orgId?: string;
  @ApiProperty() @IsString() @Matches(/^[a-z0-9._-]{3,40}$/i) username: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiProperty({ description: 'Initial password, 12+ characters' }) @IsString() password: string;
  @ApiPropertyOptional({ enum: [Role.OPERATOR, Role.SUPERVISOR] }) @IsOptional() @IsIn([Role.OPERATOR, Role.SUPERVISOR]) role?: Role;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) employeeCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(1000) routingPriority?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsUUID('all', { each: true }) @ArrayMaxSize(100) regionIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsUUID('all', { each: true }) @ArrayMaxSize(500) groupIds?: string[];
}

export class UpdateOperatorDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) employeeCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(1000) routingPriority?: number;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] }) @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsUUID('all', { each: true }) @ArrayMaxSize(100) regionIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsUUID('all', { each: true }) @ArrayMaxSize(500) groupIds?: string[];
}

export class SetPresenceDto {
  @ApiProperty({ enum: SELECTABLE_AVAILABILITY }) @IsIn(SELECTABLE_AVAILABILITY as string[]) availability: Availability;
}

export class HeartbeatDto {
  @ApiProperty() @IsBoolean() sipRegistered: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Boolean) @IsBoolean() mediaFault?: boolean;
}
