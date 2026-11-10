import { Module } from '@nestjs/common';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';

@Module({ providers: [AssignmentsService], controllers: [AssignmentsController], exports: [AssignmentsService] })
export class AssignmentsModule {}
