import { Module, forwardRef } from '@nestjs/common';
import { ItemsService } from './items.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [forwardRef(() => UsersModule)],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}

