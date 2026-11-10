import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class PageQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 500 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  pageSize = 50;

  @ApiPropertyOptional({ description: 'Super administrators only: target organization' })
  @IsOptional() @IsUUID()
  orgId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  sort?: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export const offset = (q: PageQuery) => (q.page - 1) * q.pageSize;

/** Whitelisted ORDER BY: `sort=-lastSeen` -> "last_seen_at DESC". */
export function orderBy(sort: string | undefined, allowed: Record<string, string>, fallback: string): string {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const col = allowed[desc ? sort.slice(1) : sort];
  return col ? `${col} ${desc ? 'DESC' : 'ASC'} NULLS LAST` : fallback;
}
