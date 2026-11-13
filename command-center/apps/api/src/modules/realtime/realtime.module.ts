import { Global, Module } from '@nestjs/common';
import { OperatorsModule } from '../operators/operators.module';
import { EventBusService } from './event-bus.service';
import { EventsGateway } from './events.gateway';

/** Event bus is global so any module can publish without import cycles. */
@Global()
@Module({ providers: [EventBusService], exports: [EventBusService] })
export class EventBusModule {}

@Module({ imports: [OperatorsModule], providers: [EventsGateway], exports: [EventsGateway] })
export class RealtimeModule {}
