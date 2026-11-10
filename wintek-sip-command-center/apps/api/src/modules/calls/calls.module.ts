import { Module } from '@nestjs/common';
import { config } from '../../config';
import { AssignmentsModule } from '../assignments/assignments.module';
import { AtmsModule } from '../atms/atms.module';
import { OperatorsModule } from '../operators/operators.module';
import { QueueModule } from '../queue/queue.module';
import { CallSweeperService } from './call-sweeper.service';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { AriSipDriver } from './sip/ari.driver';
import { SIP_DRIVER } from './sip/sip-driver';
import { SimulatedSipDriver } from './sip/simulated.driver';

@Module({
  imports: [AssignmentsModule, AtmsModule, OperatorsModule, QueueModule],
  providers: [
    {
      provide: SIP_DRIVER,
      useFactory: () => {
        const c = config();
        if (c.SIP_DRIVER === 'simulated') return new SimulatedSipDriver(`sim-${c.NODE_ID}`);
        return new AriSipDriver({
          url: c.ARI_URL, user: c.ARI_USER, password: c.ARI_PASSWORD, app: c.ARI_APP, node: c.MEDIA_NODE_ID,
          dialMode: c.ATM_DIAL_MODE, kamailioTrunk: c.KAMAILIO_TRUNK_ENDPOINT,
        });
      },
    },
    CallsService,
    CallSweeperService,
  ],
  controllers: [CallsController],
  exports: [CallsService, CallSweeperService, SIP_DRIVER],
})
export class CallsModule {}
