package push

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi/types"

	"github.com/incognitochat/incognitochat/backend/internal/dynamotest"
	"github.com/incognitochat/incognitochat/backend/internal/ephemeral"
)

type memSockets struct {
	mu        sync.Mutex
	conns     map[string][]string
	forgotten []string
}

func (m *memSockets) Connections(_ context.Context, account string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.conns[account]), nil
}

func (m *memSockets) Forget(_ context.Context, account, c string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.forgotten = append(m.forgotten, account+"/"+c)
	return nil
}

type memAPI struct {
	mu   sync.Mutex
	sent []string
	fail map[string]error
}

func (m *memAPI) PostToConnection(_ context.Context, in *apigatewaymanagementapi.PostToConnectionInput, _ ...func(*apigatewaymanagementapi.Options)) (*apigatewaymanagementapi.PostToConnectionOutput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail[*in.ConnectionId]; err != nil {
		return nil, err
	}
	if string(in.Data) != `{"t":"sync"}` {
		return nil, errors.New("unexpected data")
	}
	m.sent = append(m.sent, *in.ConnectionId)
	return &apigatewaymanagementapi.PostToConnectionOutput{}, nil
}

func TestPush(t *testing.T) {
	sockets := &memSockets{conns: map[string][]string{"a": {"c1", "c2", "c3"}, "b": {"c4"}}}
	api := &memAPI{fail: map[string]error{"c2": &types.GoneException{}, "c4": errors.New("throttled")}}
	p := &Pusher{Sockets: sockets, API: api}
	ctx := context.Background()

	ok, err := p.Push(ctx, "a")
	if !ok || err != nil {
		t.Fatalf("push: %v %v", ok, err)
	}
	slices.Sort(api.sent)
	if !slices.Equal(api.sent, []string{"c1", "c3"}) {
		t.Fatalf("sent = %v", api.sent)
	}
	if !slices.Equal(sockets.forgotten, []string{"a/c2"}) {
		t.Fatalf("forgotten = %v", sockets.forgotten)
	}
	// Nobody took it.
	if ok, err := p.Push(ctx, "b"); ok || err == nil {
		t.Fatalf("failing push: %v %v", ok, err)
	}
	if ok, err := p.Push(ctx, ""); ok || err != nil {
		t.Fatalf("empty account: %v %v", ok, err)
	}
}

// Records of closed sockets, however many and however new, don't crowd out
// an open one behind them: they answer gone, are forgotten, and the next
// ones are tried.
func TestPushPastClosedSockets(t *testing.T) {
	var conns []string
	fail := map[string]error{}
	for i := range 7 {
		c := "closed" + strconv.Itoa(i)
		conns = append(conns, c)
		fail[c] = &types.GoneException{}
	}
	conns = append(conns, "open")
	sockets := &memSockets{conns: map[string][]string{"a": conns}}
	api := &memAPI{fail: fail}
	p := &Pusher{Sockets: sockets, API: api}
	if ok, err := p.Push(context.Background(), "a"); !ok || err != nil {
		t.Fatalf("push: %v %v", ok, err)
	}
	if !slices.Equal(api.sent, []string{"open"}) || len(sockets.forgotten) != 7 {
		t.Fatalf("sent %v, forgot %v", api.sent, sockets.forgotten)
	}
}

// A delivery reaches Fanout open sockets at most, the newest.
func TestPushFanout(t *testing.T) {
	var conns []string
	for i := range Fanout + 3 {
		conns = append(conns, "c"+strconv.Itoa(i))
	}
	api := &memAPI{}
	p := &Pusher{Sockets: &memSockets{conns: map[string][]string{"a": conns}}, API: api}
	if ok, err := p.Push(context.Background(), "a"); !ok || err != nil {
		t.Fatalf("push: %v %v", ok, err)
	}
	slices.Sort(api.sent)
	if !slices.Equal(api.sent, conns[:Fanout]) {
		t.Fatalf("sent = %v, want the newest %v", api.sent, conns[:Fanout])
	}
}

// liveAPI answers like API Gateway: gone for sockets that have closed.
type liveAPI struct {
	mu   sync.Mutex
	open map[string]bool
	sent []string
}

func (l *liveAPI) PostToConnection(_ context.Context, in *apigatewaymanagementapi.PostToConnectionInput, _ ...func(*apigatewaymanagementapi.Options)) (*apigatewaymanagementapi.PostToConnectionOutput, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.open[*in.ConnectionId] {
		return nil, &types.GoneException{}
	}
	l.sent = append(l.sent, *in.ConnectionId)
	return &apigatewaymanagementapi.PostToConnectionOutput{}, nil
}

func (l *liveAPI) set(c string, open bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.open[c] = open
}

func (l *liveAPI) took() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	sent := l.sent
	l.sent = nil
	return sent
}

// One copy of the app stays open while another is shown and hidden again
// and again (a new socket each time, closed without a record of it): the
// open one keeps getting pushes, and the closed ones are forgotten.
func TestOpenCopyKeepsGettingPushes(t *testing.T) {
	client := dynamotest.Client(t)
	clock := time.Unix(1_800_000_000, 0)
	sockets := &ephemeral.Sockets{DB: client, Table: dynamotest.Table(t, client), Now: func() time.Time { return clock }}
	api := &liveAPI{open: map[string]bool{}}
	p := &Pusher{Sockets: sockets, API: api}
	ctx := context.Background()

	if err := sockets.Open(ctx, "acct", "A"); err != nil {
		t.Fatal(err)
	}
	api.set("A", true)
	churn := func(i int, push bool) {
		t.Helper()
		clock = clock.Add(20 * time.Second)
		b := "B" + strconv.Itoa(i)
		if err := sockets.Open(ctx, "acct", b); err != nil {
			t.Fatalf("connect %s: %v", b, err)
		}
		api.set(b, true)
		if push {
			if ok, err := p.Push(ctx, "acct"); !ok || err != nil {
				t.Fatalf("push %d: %v %v", i, ok, err)
			}
			if sent := api.took(); !slices.Contains(sent, "A") {
				t.Fatalf("push %d reached %v, not the open copy", i, sent)
			}
		}
		api.set(b, false)
	}
	// Deliveries come in between.
	for i := range 40 {
		churn(i, true)
	}
	// None for a while: up to MaxRecords-2 closed sockets on record still
	// leave room for the open one.
	if _, err := p.Push(ctx, "acct"); err != nil {
		t.Fatal(err)
	}
	api.took()
	for i := range ephemeral.MaxRecords - 2 {
		churn(100+i, false)
	}
	if ok, err := p.Push(ctx, "acct"); !ok || err != nil {
		t.Fatalf("push: %v %v", ok, err)
	}
	if sent := api.took(); !slices.Equal(sent, []string{"A"}) {
		t.Fatalf("reached %v", sent)
	}
	// The closed ones were forgotten on the way.
	if conns, _ := sockets.Connections(ctx, "acct"); !slices.Equal(conns, []string{"A"}) {
		t.Fatalf("left on record: %v", conns)
	}
}
