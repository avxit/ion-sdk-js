import { grpc } from '@improbable-eng/grpc-web';
import { EventEmitter } from 'events';
import { JoinResult, PeerState, StreamState } from '../ion';
import { textDecoder, textEncoder } from './utils';
import * as biz from './_proto/library/biz/biz_pb';
import * as biz_rpc from './_proto/library/biz/biz_pb_service';
import * as ion from './_proto/library/biz/ion_pb';

export class BizClient extends EventEmitter {
  protected client: biz_rpc.BizClient;
  protected streaming: biz_rpc.BidirectionalStream<biz.SignalRequest, biz.SignalReply>;

  constructor(uri: string) {
    super();
    this.client = new biz_rpc.BizClient(uri, {
      transport: grpc.WebsocketTransport(),
    });

    this.streaming = this.client.signal();
    this.streaming.on('data', (reply: biz.SignalReply) => {
      switch (reply.getPayloadCase()) {
        case biz.SignalReply.PayloadCase.JOINREPLY:
          const result = {
            success: reply.getJoinreply()?.getSuccess() || false,
            reason: reply.getJoinreply()?.getReason() || 'unkown reason',
          };
          this.emit('join-reply', result.success, result.reason);
          break;
        case biz.SignalReply.PayloadCase.LEAVEREPLY:
          const reason = reply.getLeavereply()?.getReason() || 'unkown reason';
          this.emit('leave-reply', reason);
          break;
        case biz.SignalReply.PayloadCase.PEEREVENT:
          {
            const evt = reply.getPeerevent();
            let state = PeerState.NONE;
            const evtPeerInfo = evt?.getPeer()?.getInfo();
            const info = evtPeerInfo instanceof Uint8Array ? JSON.parse(textDecoder.decode(evtPeerInfo)) : evtPeerInfo;
            switch (evt?.getState()) {
              case ion.PeerEvent.State.JOIN:
                state = PeerState.JOIN;
                break;
              case ion.PeerEvent.State.UPDATE:
                state = PeerState.UPDATE;

                break;
              case ion.PeerEvent.State.LEAVE:
                state = PeerState.LEAVE;
                break;
            }
            const peer = {
              uid: evt?.getPeer()?.getUid() || '',
              sid: evt?.getPeer()?.getSid() || '',
              info: info || {},
            };
            this.emit('peer-event', { state, peer });
          }
          break;
        case biz.SignalReply.PayloadCase.STREAMEVENT:
          {
            const evt = reply.getStreamevent();
            let state = StreamState.NONE;
            switch (evt?.getState()) {
              case ion.StreamEvent.State.ADD:
                state = StreamState.ADD;
                break;
              case ion.StreamEvent.State.REMOVE:
                state = StreamState.REMOVE;
                break;
            }
            const sid = evt?.getSid() || '';
            const uid = evt?.getUid() || '';
            const streams = Array<any>();
            evt?.getStreamsList().forEach((ionStream: ion.Stream) => {
              const tracks = Array<any>();
              ionStream.getTracksList().forEach((ionTrack: ion.Track) => {
                const track = {
                  id: ionTrack.getId(),
                  label: ionTrack.getLabel(),
                  kind: ionTrack.getKind(),
                  simulcast: ionTrack.getSimulcastMap(),
                };
                tracks.push(track);
              });
              const stream = {
                id: ionStream.getId(),
                tracks: tracks || [],
              };
              streams.push(stream);
            });
            this.emit('stream-event', { state, sid, uid, streams });
          }
          break;
        case biz.SignalReply.PayloadCase.MSG:
          const replyMsgData = reply.getMsg()?.getData();
          const data = replyMsgData instanceof Uint8Array ? JSON.parse(textDecoder.decode(replyMsgData)) : replyMsgData;
          const msg = { from: reply.getMsg()?.getFrom() || '', to: reply.getMsg()?.getTo() || '', data: data || {} };
          this.emit('message', msg);
          break;
      }
    });
  }

  async join(sid: string, uid: string, info: Record<string, any>, token: string | undefined): Promise<JoinResult> {
    const request = new biz.SignalRequest();
    const join = new biz.Join();
    join.setToken(token || '');
    const peer = new ion.Peer();
    peer.setSid(sid);
    peer.setUid(uid);

    const buffer = textEncoder.encode(JSON.stringify(info));
    peer.setInfo(buffer);

    join.setPeer(peer);
    request.setJoin(join);

    this.streaming.write(request);

    return new Promise<JoinResult>((resolve, reject) => {
      const handler = (result: JoinResult) => {
        resolve(result);
        this.removeListener('join-reply', handler);
      };
      this.addListener('join-reply', handler);
    });
  }

  async leave(uid: string) {
    const request = new biz.SignalRequest();
    const leave = new biz.Leave();
    leave.setUid(uid);
    request.setLeave(leave);

    this.streaming.write(request);

    return new Promise<string>((resolve, reject) => {
      const handler = (reason: string) => {
        resolve(reason);
        this.removeListener('join-reply', handler);
      };
      this.addListener('join-reply', handler);
    });
  }

  async sendMessage(from: string, to: string, data: Record<string, any>) {
    const request = new biz.SignalRequest();
    const message = new ion.Message();
    message.setFrom(from);
    message.setTo(to);
    const buffer = textEncoder.encode(JSON.stringify(data));
    message.setData(buffer);
    request.setMsg(message);
    this.streaming.write(request);
  }

  close() {
    this.streaming.end();
  }
}
