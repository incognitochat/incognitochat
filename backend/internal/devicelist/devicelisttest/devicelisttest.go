// Package devicelisttest builds device lists for tests, as the app does
// (web/src/protocol/device-list.ts). The server only reads them.
package devicelisttest

import (
	"encoding/binary"

	"github.com/incognitochat/incognitochat/backend/internal/devicelist"
	"github.com/incognitochat/incognitochat/backend/internal/devicesig"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// Encode returns the list's signed bytes.
func Encode(l devicelist.List) []byte {
	parts := [][]byte{
		{devicesig.Suite},
		u64(l.Seq),
		l.Prev[:],
		u64(uint64(l.Issued.Unix())),
		u64(uint64(l.Expires.Unix())),
	}
	for _, e := range l.Entries {
		id, _ := ids.Decode(e.DeviceID)
		parts = append(parts, id[:], e.Key, u64(uint64(e.Added.Unix())))
	}
	return devicesig.Message(devicesig.LabelDeviceList, parts...)
}

func u64(v uint64) []byte {
	return binary.BigEndian.AppendUint64(nil, v)
}
