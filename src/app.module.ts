import { Body, Controller, Get, HttpCode, Module, Param, Post } from '@nestjs/common';
import { parseMutation, validateUserId } from './http';
import { WalletService } from './wallet.service';

@Controller()
class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get('balance/:user_id')
  balance(@Param('user_id') userId: string) {
    return this.wallets.balance(validateUserId(userId));
  }

  @Post('credit')
  @HttpCode(200)
  credit(@Body() body: unknown) {
    const { userId, amount } = parseMutation(body);
    return this.wallets.credit(userId, amount);
  }

  @Post('debit')
  @HttpCode(200)
  debit(@Body() body: unknown) {
    const { userId, amount } = parseMutation(body);
    return this.wallets.debit(userId, amount);
  }
}

@Module({ controllers: [WalletController], providers: [WalletService] })
export class AppModule {}
