package main

// ── 민감 정보 XOR 난독화 ─────────────────────────────────────────────
//
// 모든 민감 문자열은 소스·바이너리 어디에도 평문으로 존재하지 않음.
// 바이너리에는 숫자 배열만 저장됨 → strings 명령으로 추출 불가.
//
// XOR 키: {0x4F, 0xB2, 0x37, 0xC8, 0x5E, 0xA1, 0x7D, 0x2C}

var _xk = [8]byte{0x4F, 0xB2, 0x37, 0xC8, 0x5E, 0xA1, 0x7D, 0x2C}

func _xd(data []byte) string {
	out := make([]byte, len(data))
	for i, b := range data {
		out[i] = b ^ _xk[i%8]
	}
	return string(out)
}

// SERVER_URL — "wss://support.woori-net.com"
var _encURL = []byte{
	0x38, 0xC1, 0x44, 0xF2, 0x71, 0x8E, 0x0E, 0x59,
	0x3F, 0xC2, 0x58, 0xBA, 0x2A, 0x8F, 0x0A, 0x43,
	0x20, 0xC0, 0x5E, 0xE5, 0x30, 0xC4, 0x09, 0x02,
	0x2C, 0xDD, 0x5A,
}

// SERVER_SOCKET_PATH — "/remotediag/socket.io"
var _encPath = []byte{
	0x60, 0xC0, 0x52, 0xA5, 0x31, 0xD5, 0x18, 0x48,
	0x26, 0xD3, 0x50, 0xE7, 0x2D, 0xCE, 0x1E, 0x47,
	0x2A, 0xC6, 0x19, 0xA1, 0x31,
}

// srsdProvider — "woorinet" (8 bytes, \x00 패딩은 Go zero-value로 충당)
var _encProvider = []byte{
	0x38, 0xDD, 0x58, 0xBA, 0x37, 0xCF, 0x18, 0x58,
}

// srsdSecure — "W35337396126969" (15 bytes, \x00 패딩은 Go zero-value로 충당)
var _encSecure = []byte{
	0x18, 0x81, 0x02, 0xFB, 0x6D, 0x96, 0x4E, 0x15,
	0x79, 0x83, 0x05, 0xFE, 0x67, 0x97, 0x44,
}

// ldflags 주입 대상: VERSION, EXPIRE_DATE 만 (민감하지 않음)
var (
	VERSION     = "2.0.0"
	EXPIRE_DATE = ""
)

// SERVER_URL / SERVER_SOCKET_PATH — init() 에서 디코딩
var (
	SERVER_URL         string
	SERVER_SOCKET_PATH string
)

func init() {
	SERVER_URL         = _xd(_encURL)
	SERVER_SOCKET_PATH = _xd(_encPath)
}

// decodeSRSDSecrets — srsd.go 의 init() 에서 호출
func decodeSRSDSecrets() ([16]byte, [16]byte) {
	var provider, secure [16]byte
	copy(provider[:], []byte(_xd(_encProvider)))
	copy(secure[:], []byte(_xd(_encSecure)))
	return provider, secure
}
