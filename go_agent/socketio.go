package main

// Socket.IO v4 / Engine.IO v4 클라이언트 구현
// gorilla/websocket 기반, 외부 Socket.IO 라이브러리 불필요

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type EventHandler func(data json.RawMessage)

type SocketIO struct {
	conn         *websocket.Conn
	mu           sync.Mutex
	handlers     map[string]EventHandler
	onConnect    func()
	onDisconnect func()
	connected    bool
	done         chan struct{}
	pingInterval time.Duration
	pingTimeout  time.Duration
}

func NewSocketIO() *SocketIO {
	return &SocketIO{
		handlers:     make(map[string]EventHandler),
		done:         make(chan struct{}),
		pingInterval: 25 * time.Second,
		pingTimeout:  120 * time.Second,
	}
}

func (s *SocketIO) On(event string, fn EventHandler) {
	s.handlers[event] = fn
}

func (s *SocketIO) OnConnect(fn func())    { s.onConnect = fn }
func (s *SocketIO) OnDisconnect(fn func()) { s.onDisconnect = fn }
func (s *SocketIO) Connected() bool        { return s.connected }

func (s *SocketIO) Connect(rawURL, socketPath string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	}
	u.Path = socketPath + "/"
	q := url.Values{}
	q.Set("EIO", "4")
	q.Set("transport", "websocket")
	u.RawQuery = q.Encode()

	dialer := websocket.Dialer{
		TLSClientConfig:  &tls.Config{},
		HandshakeTimeout: 15 * time.Second,
	}

	conn, _, err := dialer.Dial(u.String(), http.Header{})
	if err != nil {
		return err
	}

	s.conn = conn
	s.connected = true
	s.done = make(chan struct{})
	go s.readLoop()
	return nil
}

func (s *SocketIO) readLoop() {
	defer func() {
		s.connected = false
		if s.onDisconnect != nil {
			s.onDisconnect()
		}
		close(s.done)
	}()

	s.conn.SetReadDeadline(time.Now().Add(s.pingInterval + s.pingTimeout))

	for {
		_, msg, err := s.conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived) {
				fmt.Printf("[agent] 연결 오류: %v\n", err)
			}
			return
		}

		// 수신마다 deadline 갱신 (ping/pong 포함)
		s.conn.SetReadDeadline(time.Now().Add(s.pingInterval + s.pingTimeout))

		if len(msg) == 0 {
			continue
		}

		eioType := msg[0]
		payload := msg[1:]

		switch eioType {
		case '0': // Engine.IO OPEN
			var open struct {
				SID          string `json:"sid"`
				PingInterval int    `json:"pingInterval"`
				PingTimeout  int    `json:"pingTimeout"`
			}
			if err := json.Unmarshal(payload, &open); err == nil {
				if open.PingInterval > 0 {
					s.pingInterval = time.Duration(open.PingInterval) * time.Millisecond
				}
				if open.PingTimeout > 0 {
					s.pingTimeout = time.Duration(open.PingTimeout) * time.Millisecond
				}
			}
			// Socket.IO CONNECT (namespace "/")
			s.sendRaw([]byte("40"))

		case '2': // Engine.IO PING → PONG
			s.sendRaw([]byte("3"))

		case '4': // Engine.IO MESSAGE → Socket.IO 패킷
			s.handleSIO(payload)
		}
	}
}

func (s *SocketIO) handleSIO(data []byte) {
	if len(data) == 0 {
		return
	}
	sioType := data[0]
	payload := data[1:]

	switch sioType {
	case '0': // Socket.IO CONNECT
		if s.onConnect != nil {
			go s.onConnect()
		}

	case '2': // Socket.IO EVENT
		// 형식: ["event_name", data]
		var parts []json.RawMessage
		if err := json.Unmarshal(payload, &parts); err != nil || len(parts) == 0 {
			return
		}
		var name string
		if err := json.Unmarshal(parts[0], &name); err != nil {
			return
		}
		var eventData json.RawMessage
		if len(parts) > 1 {
			eventData = parts[1]
		}
		if fn, ok := s.handlers[name]; ok {
			go fn(eventData)
		}
	}
}

func (s *SocketIO) Emit(event string, data interface{}) error {
	payload, err := json.Marshal([]interface{}{event, data})
	if err != nil {
		return err
	}
	if err := s.sendRaw(append([]byte("42"), payload...)); err != nil {
		fmt.Printf("[agent] 전송 오류 (%s): %v\n", event, err)
		return err
	}
	return nil
}

func (s *SocketIO) sendRaw(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return fmt.Errorf("연결되지 않음")
	}
	return s.conn.WriteMessage(websocket.TextMessage, data)
}

func (s *SocketIO) Disconnect() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}
}

func (s *SocketIO) Wait() {
	<-s.done
}
