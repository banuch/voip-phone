import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { config } from '../../config';
import { AuthService, type SessionTokens } from './auth.service';

class LoginDto {
  @ApiProperty({ example: 'operator1' }) @IsString() @MinLength(1) @MaxLength(100) username: string;
  @ApiProperty({ example: '••••••••••••' }) @IsString() @MinLength(1) @MaxLength(256) password: string;
}

class SessionResponse {
  @ApiProperty() accessToken: string;
  @ApiProperty({ description: 'Seconds until the access token expires' }) accessExpiresIn: number;
  @ApiProperty() user: object;
}

const COOKIE = 'wintek_rt';
const COOKIE_PATH = '/api/v1/auth';

/**
 * The access token (15 min) is returned in the body and kept in memory by the
 * dashboard. The refresh token lives only in an httpOnly, SameSite=Strict
 * cookie scoped to /api/v1/auth, so page scripts can never read it.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private respond(res: Response, t: SessionTokens) {
    res.cookie(COOKIE, t.refreshToken, {
      httpOnly: true,
      secure: config().COOKIE_SECURE,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: t.refreshExpiresAt,
    });
    return { accessToken: t.accessToken, accessExpiresIn: t.accessExpiresIn, user: t.user };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in; sets the refresh cookie' })
  @ApiOkResponse({ type: SessionResponse })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto.username, dto.password, req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate the refresh cookie and get a new access token' })
  @ApiOkResponse({ type: SessionResponse })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // A cross-site page can't trigger this usefully: SameSite=Strict keeps the
    // cookie off cross-site requests, and the response is CORS-restricted.
    return this.respond(res, await this.auth.refresh(req.cookies?.[COOKIE], req));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the refresh token family and clear the cookie' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE], req);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user, roles and effective permissions' })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.sessionUser(user.userId);
  }
}
