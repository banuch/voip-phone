import { Module } from '@nestjs/common';
import { AtmsModule } from '../atms/atms.module';
import { OperatorsController } from './operators.controller';
import { OperatorsService } from './operators.service';
import { PresenceService } from './presence.service';

@Module({
  imports: [AtmsModule],
  providers: [OperatorsService, PresenceService],
  controllers: [OperatorsController],
  exports: [OperatorsService, PresenceService],
})
export class OperatorsModule {}
