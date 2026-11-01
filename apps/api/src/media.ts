import {
  AccessToken,
  RoomServiceClient,
  EgressClient,
  WebhookReceiver,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  AudioCodec,
  VideoCodec,
  S3Upload,
} from "livekit-server-sdk";
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "./config.js";
export function createMedia(c: Config) {
  const rooms = new RoomServiceClient(
    c.livekit.internalUrl,
    c.livekit.apiKey,
    c.livekit.apiSecret,
    { requestTimeout: 10, failover: false },
  );
  const egress = new EgressClient(
    c.livekit.internalUrl,
    c.livekit.apiKey,
    c.livekit.apiSecret,
    { requestTimeout: 30, failover: false },
  );
  const receiver = new WebhookReceiver(c.livekit.apiKey, c.livekit.apiSecret);
  const s3 = new S3Client({
    region: c.s3.region,
    endpoint: c.s3.endpoint,
    forcePathStyle: c.s3.forcePathStyle,
    credentials: { accessKeyId: c.s3.accessKey, secretAccessKey: c.s3.secret },
  });
  const publicS3 =
    c.s3.publicEndpoint === c.s3.endpoint
      ? s3
      : new S3Client({
          region: c.s3.region,
          endpoint: c.s3.publicEndpoint,
          forcePathStyle: c.s3.forcePathStyle,
          credentials: {
            accessKeyId: c.s3.accessKey,
            secretAccessKey: c.s3.secret,
          },
        });
  return {
    rooms,
    egress,
    receiver,
    async token(
      roomId: string,
      identity: string,
      name: string,
      maxParticipants: number,
    ) {
      const active = await rooms.listRooms();
      if (
        !active.some((room) => room.name === roomId) &&
        active.length >= c.limits.activeRooms
      )
        throw new Error("Media room capacity reached");
      await rooms.createRoom({
        name: roomId,
        maxParticipants,
        emptyTimeout: 300,
        departureTimeout: 30,
      });
      const token = new AccessToken(c.livekit.apiKey, c.livekit.apiSecret, {
        identity,
        name,
        ttl: 300,
      });
      token.addGrant({
        roomJoin: true,
        room: roomId,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canUpdateOwnMetadata: false,
      });
      return token.toJwt();
    },
    async start(roomId: string, key: string) {
      const output = new EncodedFileOutput({
        fileType: EncodedFileType.MP4,
        filepath: key,
        output: {
          case: "s3",
          value: new S3Upload({
            accessKey: c.s3.accessKey,
            secret: c.s3.secret,
            region: c.s3.region,
            bucket: c.s3.bucket,
            endpoint: c.s3.endpoint,
            forcePathStyle: c.s3.forcePathStyle,
          }),
        },
      });
      return egress.startRoomCompositeEgress(
        roomId,
        { file: output },
        {
          layout: "grid",
          // Deliberately bounded shared-host profile. The worker separately
          // enforces 30 minutes / 350 MiB and a single active recording.
          encodingOptions: new EncodingOptions({
            width: 1280,
            height: 720,
            framerate: 15,
            videoCodec: VideoCodec.H264_MAIN,
            videoBitrate: 1200,
            audioCodec: AudioCodec.AAC,
            audioBitrate: 64,
            audioFrequency: 48000,
            keyFrameInterval: 4,
          }),
        },
      );
    },
    async delete(key: string) {
      await s3.send(new DeleteObjectCommand({ Bucket: c.s3.bucket, Key: key }));
    },
    async download(key: string) {
      return getSignedUrl(
        publicS3,
        new GetObjectCommand({ Bucket: c.s3.bucket, Key: key }),
        { expiresIn: 60 },
      );
    },
  };
}
export type Media = ReturnType<typeof createMedia>;

export function mediaRoomName(room: { id: string; media_generation?: number }) {
  return room.media_generation
    ? `${room.id}-g${room.media_generation}`
    : room.id;
}
