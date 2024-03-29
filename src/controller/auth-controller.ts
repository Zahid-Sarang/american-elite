import { NextFunction, Request, Response } from "express";
import { UserService } from "../service/user-service";
import { Logger } from "winston";
import {
    AuthRequest,
    CreateUserRequest,
    LoginRequest,
} from "../types/user-types";
import { validationResult } from "express-validator";
import createHttpError from "http-errors";
import { HashedPasswordService } from "../service/hashedPassword-Service";
import { FileStorage } from "../types/storage-types";
import { JwtTokenService } from "../service/jwtToken-service";
import { JwtPayload } from "jsonwebtoken";

export class AuthController {
    constructor(
        private userService: UserService,
        private logger: Logger,
        private hashedPasswordSerivce: HashedPasswordService,
        private imageStorage: FileStorage,
        private jwtTokenService: JwtTokenService,
    ) {}
    private setCookies(
        res: Response,
        accessToken: string,
        refreshToken: string,
    ) {
        res.cookie("accessToken", accessToken, {
            domain: "localhost",
            sameSite: "strict",
            maxAge: 1000 * 60 * 60, // 60 minutes
            httpOnly: true,
        });

        res.cookie("refreshToken", refreshToken, {
            domain: "localhost",
            sameSite: "strict",
            maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
            httpOnly: true,
        });
    }

    register = async (
        req: CreateUserRequest,
        res: Response,
        next: NextFunction,
    ) => {
        // validate the request Data
        const requestValidationError = validationResult(req);
        if (!requestValidationError.isEmpty()) {
            return next(
                createHttpError(
                    400,
                    requestValidationError.array()[0].msg as string,
                ),
            );
        }

        const { userName, email, password, bio } = req.body;

        const hashedPassword =
            await this.hashedPasswordSerivce.hashPassword(password);

        // validate profile Image path
        const profileImageLocalPath = req.file?.path;
        if (!profileImageLocalPath) {
            return next(createHttpError(400, "Please Upload Image"));
        }

        // upload image on Cloudinary
        const profileImageLink = await this.imageStorage.upload(
            profileImageLocalPath,
        );

        if (!profileImageLink || !profileImageLink.url) {
            return next(createHttpError(500, "Failed to upload image"));
        }

        const user = await this.userService.createUser({
            userName,
            email,
            password: hashedPassword,
            bio,
            profileImage: profileImageLink.url,
        });

        // generate Tokens
        const payload: JwtPayload = {
            sub: String(user.id),
            email: user.email,
        };

        const accessToken = this.jwtTokenService.generateAccessToken(payload);
        const newRefreshToken =
            await this.jwtTokenService.persistRefreshToken(user);
        const refreshToken = this.jwtTokenService.generateRefreshToken({
            ...payload,
            id: String(newRefreshToken.id),
        });
        this.setCookies(res, accessToken, refreshToken);
        res.status(201).json({ id: user._id });
    };

    // Log in Method
    login = async (req: LoginRequest, res: Response, next: NextFunction) => {
        // validate the request Data
        const requestValidationError = validationResult(req);
        if (!requestValidationError.isEmpty()) {
            return next(
                createHttpError(
                    400,
                    requestValidationError.array()[0].msg as string,
                ),
            );
        }
        const { email, password } = req.body;

        const user = await this.userService.findByEmail(email);

        if (!user) {
            const error = createHttpError(400, "Email and password not match!");
            return next(error);
        }

        // compare password
        const isPasswordMatch =
            await this.hashedPasswordSerivce.comparePassword(
                password,
                user.password,
            );
        if (!isPasswordMatch) {
            const error = createHttpError(400, "Email and password not match!");
            return next(error);
        }

        // generate token

        const payload: JwtPayload = {
            sub: String(user.id),
            email: user.email,
        };

        const accessToken = this.jwtTokenService.generateAccessToken(payload);
        const newRefreshToken =
            await this.jwtTokenService.persistRefreshToken(user);
        const refreshToken = this.jwtTokenService.generateRefreshToken({
            ...payload,
            id: String(newRefreshToken.id),
        });
        this.setCookies(res, accessToken, refreshToken);
        this.logger.info("User hasb been logged in successfully", {
            id: user.id as string,
        });

        res.status(200).json({ id: user.id as string });
    };

    // get Self Info
    self = async (req: Request, res: Response) => {
        const authReq = req as AuthRequest;
        const user = await this.userService.findById(authReq.auth.sub);
        res.json(user);
    };

    // refresh Token rotation
    refreshTokenGenerate = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {
        const authReq = req as AuthRequest;
        const payload: JwtPayload = {
            sub: authReq.auth.sub,
            email: authReq.auth.email,
        };
        const accessToken = this.jwtTokenService.generateAccessToken(payload);

        // check user with that token exist
        const user = await this.userService.findById(authReq.auth.sub);
        if (!user) {
            const error = createHttpError(
                400,
                "User with token could not found",
            );
            return next(error);
        }
        const newRefreshToken =
            await this.jwtTokenService.persistRefreshToken(user);

        // delete Old Token
        await this.jwtTokenService.deleteRefreshToken(authReq.auth.id!);

        const refreshToken = this.jwtTokenService.generateRefreshToken({
            ...payload,
            id: String(newRefreshToken.id),
        });
        this.setCookies(res, accessToken, refreshToken);
        this.logger.info("new refresh token generated for", authReq.auth.sub);
        res.json("new refresh token generateds");
    };

    // Logout
    logout = async (req: Request, res: Response) => {
        const authReq = req as AuthRequest;
        await this.jwtTokenService.deleteRefreshToken(authReq.auth.id!);
        this.logger.info("Refresh token has been deleted", {
            id: authReq.auth.id,
        });
        res.clearCookie("accessToken");
        res.clearCookie("refreshToken");
        res.json("Successfully logged out");
    };
}
