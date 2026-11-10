import { Module } from '@nestjs/common';
import { AtmsController, InternalSipController } from './atms.controller';
import { AtmsService } from './atms.service';
import { DeviceStatusService } from './device-status.service';
import { SipIdentityService } from './sip-identity.service';

@Module({
  providers: [AtmsService, DeviceStatusService, SipIdentityService],
  controllers: [AtmsController, InternalSipController],
  exports: [AtmsService, DeviceStatusService, SipIdentityService],
})
export class AtmsModule {}
