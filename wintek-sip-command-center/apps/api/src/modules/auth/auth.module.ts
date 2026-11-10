import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RbacSyncService } from './rbac-sync.service';

@Module({ providers: [AuthService, RbacSyncService], controllers: [AuthController], exports: [AuthService] })
export class AuthModule {}
