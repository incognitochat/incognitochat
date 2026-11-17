// Package inbox stores undelivered envelopes in the messages table, one item
// per message per device (design §12, §14):
//
//	D#<account>#<device>  <random ID>  mailbox (m), envelope (b), expiry (e)
//
// No sender, no account of the sender, no precise time: the expiry is 30 days
// after delivery, rounded up to the hour. A device confirms what it stored,
// which deletes its items; whatever isn't confirmed expires.
package inbox

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/envelope"
	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

const (
	// TTL is how long an undelivered message is kept (design D13).
	TTL = 30 * 24 * time.Hour

	batchSize  = 25
	maxRetries = 5
	// ackParallel is how many of Ack's deletes run at once.
	ackParallel = 10
)

// DB is the part of the DynamoDB client the inbox uses.
type DB interface {
	Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	BatchWriteItem(context.Context, *dynamodb.BatchWriteItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error)
	DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
}

// Store is the messages table.
type Store struct {
	DB    DB
	Table string
	// AckTimeout bounds an Ack (3 seconds if zero): what isn't deleted by
	// then is reported as failed, to try again, well within the function's
	// own time limit.
	AckTimeout time.Duration
}

// Item is one undelivered envelope.
type Item struct {
	ID       string
	Mailbox  string
	Envelope []byte
	// Size is about what the item takes as stored (List sets it): deleting
	// it costs a write unit per started KiB.
	Size int
}

func devicePK(accountID, deviceID string) string { return "D#" + accountID + "#" + deviceID }

// Deliver stores an envelope once for each of the owner's devices.
func (s *Store) Deliver(ctx context.Context, accountID string, devices []string, mailbox string, envelope []byte, now time.Time) error {
	expires := strconv.FormatInt(now.Add(TTL+time.Hour-time.Nanosecond).Truncate(time.Hour).Unix(), 10)
	requests := make([]types.WriteRequest, 0, len(devices))
	for _, d := range devices {
		requests = append(requests, types.WriteRequest{PutRequest: &types.PutRequest{Item: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: devicePK(accountID, d)},
			"sk": &types.AttributeValueMemberS{Value: ids.New()},
			"m":  &types.AttributeValueMemberS{Value: mailbox},
			"b":  &types.AttributeValueMemberB{Value: envelope},
			"e":  &types.AttributeValueMemberN{Value: expires},
		}}})
	}
	return s.write(ctx, requests)
}

// MaxItemSize bounds what one stored item can take, as DynamoDB counts it:
// the largest envelope, plus its key and the other attributes.
var MaxItemSize = envelope.MaxLen + 256

const (
	// probeItems is what List's first read asks for: enough to tell an
	// inbox of one item, the usual one, from one that has more.
	probeItems = 2
	// minStep is the fewest items one of List's later reads asks for while
	// the page still has room for an item of MaxItemSize, so a page of
	// small items takes a few reads, not one per few items.
	minStep = 16
	// maxReads bounds the reads of one page, and so what their rounding up
	// costs: a page of 50 small items takes 5.
	maxReads = 12
)

// Units is what deleting the item costs, in write units: one per started
// KiB, as stored.
func (it Item) Units() int { return max((it.Size+1023)/1024, 1) }

// PageLimits bound a page of List.
type PageLimits struct {
	// Items is the most items a page returns, and Units the most write
	// units (Item.Units) they claim in all.
	Items, Units int
	// Bytes is about the most a page reads, as stored.
	Bytes int
}

// WorstUnits is the most read units a page within these limits can take:
// List's reads stop once an item of MaxItemSize would no longer fit in
// Bytes, so they read at most Bytes and minStep-1 of the largest items,
// each read rounded up to 4 KiB, at half a unit (eventually consistent).
func (p PageLimits) WorstUnits() int {
	bytes := p.Bytes + (minStep-1)*MaxItemSize
	return (bytes+8191)/8192 + (maxReads+1)/2
}

// Page is part of a device's undelivered envelopes.
type Page struct {
	Items []Item
	// After, if not empty, is where the next page starts: there may be more.
	After string
	// Read is how many items the page read, expired ones too, and Units the
	// read capacity units that took.
	Read  int
	Units float64
}

// ErrStop is what a List's more function returns to end the page early.
var ErrStop = errors.New("inbox: page stopped")

// List returns a page of a device's undelivered envelopes, in no
// meaningful order (random IDs), from after (the start if empty), within
// limits. Reading is charged by the size of what is read, so the page is
// read in steps. The first reads probeItems; if that isn't all, List calls
// more (if not nil) before reading on, so a caller can take what the rest
// may cost first, and returns its error, with what was read, if it fails.
// Each later step asks for as many items as what is left of limits.Bytes
// could take even if every item were as big as can be, but at least
// minStep; the page ends once an item that big would no longer fit, or
// after maxReads. So no page reads more than limits.WorstUnits. Items past
// limits.Units are left for the next page. Expired items, not yet removed
// by TTL, count towards limits.Bytes but aren't returned, so a page can be
// empty and still have more after it.
//
// Reads are eventually consistent, at half the cost: an item just
// confirmed may be listed again, and the client skips what it has.
func (s *Store) List(ctx context.Context, accountID, deviceID, after string, limits PageLimits, now time.Time, more func() error) (Page, error) {
	pk := devicePK(accountID, deviceID)
	var start map[string]types.AttributeValue
	if after != "" {
		start = map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: pk},
			"sk": &types.AttributeValueMemberS{Value: after},
		}
	}
	var page Page
	read, units, prev := 0, 0, after
	limit := min(probeItems, limits.Items)
	for reads := 1; ; reads++ {
		out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
			TableName:              &s.Table,
			KeyConditionExpression: aws.String("pk = :pk"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk": &types.AttributeValueMemberS{Value: pk},
			},
			ExclusiveStartKey:      start,
			Limit:                  aws.Int32(int32(limit)),
			ReturnConsumedCapacity: types.ReturnConsumedCapacityTotal,
		})
		if err != nil {
			return page, err
		}
		if out.ConsumedCapacity != nil {
			page.Units += aws.ToFloat64(out.ConsumedCapacity.CapacityUnits)
		}
		page.Read += len(out.Items)
		for _, it := range out.Items {
			size := itemSize(it)
			read += size
			id, ok1 := it["sk"].(*types.AttributeValueMemberS)
			mb, ok2 := it["m"].(*types.AttributeValueMemberS)
			env, ok3 := it["b"].(*types.AttributeValueMemberB)
			if !ok1 {
				continue
			}
			live := ok2 && ok3
			if e, ok := it["e"].(*types.AttributeValueMemberN); ok {
				if v, err := strconv.ParseInt(e.Value, 10, 64); err != nil || v <= now.Unix() {
					live = false // expired, not yet removed by TTL
				}
			}
			if live {
				item := Item{ID: id.Value, Mailbox: mb.Value, Envelope: env.Value, Size: size}
				if len(page.Items) > 0 && units+item.Units() > limits.Units {
					// More than a confirmation may claim: the next page
					// starts with this item.
					page.After = prev
					return page, nil
				}
				units += item.Units()
				page.Items = append(page.Items, item)
			}
			prev = id.Value
		}
		if len(out.LastEvaluatedKey) == 0 {
			return page, nil
		}
		start = out.LastEvaluatedKey
		if reads == 1 && more != nil {
			if err := more(); err != nil {
				return page, err
			}
		}
		if len(page.Items) >= limits.Items || limits.Bytes-read < MaxItemSize || reads >= maxReads {
			if sk, ok := start["sk"].(*types.AttributeValueMemberS); ok {
				page.After = sk.Value
			}
			return page, nil
		}
		limit = min(limits.Items-len(page.Items), max((limits.Bytes-read)/MaxItemSize, minStep))
	}
}

// itemSize is about what DynamoDB counts an item as, at least: the length
// of each attribute's name and value (numbers as written, an overestimate).
func itemSize(item map[string]types.AttributeValue) int {
	size := 0
	for name, v := range item {
		size += len(name)
		switch v := v.(type) {
		case *types.AttributeValueMemberS:
			size += len(v.Value)
		case *types.AttributeValueMemberB:
			size += len(v.Value)
		case *types.AttributeValueMemberN:
			size += len(v.Value)
		}
	}
	return size
}

// Ack deletes a device's items that it has stored. It reports how many of
// them weren't there (deleted already, or never stored), and the IDs of
// those it couldn't delete (an error, such as throttling), to try again.
// Each delete is conditional on the item being there: that costs what an
// unconditional delete does (a write unit for a missing item), and tells
// which were missing, which a batch delete doesn't.
func (s *Store) Ack(ctx context.Context, accountID, deviceID string, itemIDs []string) (missing int, failed []string) {
	pk := devicePK(accountID, deviceID)
	timeout := s.AckTimeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var (
		wg sync.WaitGroup
		mu sync.Mutex
	)
	slots := make(chan struct{}, ackParallel)
	for _, id := range itemIDs {
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer func() { <-slots; wg.Done() }()
			_, err := s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
				TableName: &s.Table,
				Key: map[string]types.AttributeValue{
					"pk": &types.AttributeValueMemberS{Value: pk},
					"sk": &types.AttributeValueMemberS{Value: id},
				},
				ConditionExpression: aws.String("attribute_exists(sk)"),
			}, func(o *dynamodb.Options) { o.RetryMaxAttempts = 2 })
			var gone *types.ConditionalCheckFailedException
			mu.Lock()
			defer mu.Unlock()
			switch {
			case errors.As(err, &gone):
				missing++
			case err != nil:
				failed = append(failed, id)
			}
		}()
	}
	wg.Wait()
	return missing, failed
}

// Clear deletes up to max of a device's undelivered items (its account is
// being deleted, in steps), and reports how many it deleted and whether
// any may be left.
func (s *Store) Clear(ctx context.Context, accountID, deviceID string, max int) (int, bool, error) {
	out, err := s.DB.Query(ctx, &dynamodb.QueryInput{
		TableName:              &s.Table,
		KeyConditionExpression: aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk": &types.AttributeValueMemberS{Value: devicePK(accountID, deviceID)},
		},
		ProjectionExpression: aws.String("pk, sk"),
		ConsistentRead:       aws.Bool(true),
		Limit:                aws.Int32(int32(max)),
	})
	if err != nil {
		return 0, false, err
	}
	requests := make([]types.WriteRequest, 0, len(out.Items))
	for _, it := range out.Items {
		requests = append(requests, types.WriteRequest{DeleteRequest: &types.DeleteRequest{Key: map[string]types.AttributeValue{
			"pk": it["pk"],
			"sk": it["sk"],
		}}})
	}
	if err := s.write(ctx, requests); err != nil {
		return 0, false, err
	}
	return len(requests), out.LastEvaluatedKey != nil, nil
}

func (s *Store) write(ctx context.Context, requests []types.WriteRequest) error {
	for len(requests) > 0 {
		n := min(batchSize, len(requests))
		pending := map[string][]types.WriteRequest{s.Table: requests[:n]}
		requests = requests[n:]
		for attempt := 0; len(pending[s.Table]) > 0; attempt++ {
			if attempt == maxRetries {
				return errors.New("inbox: batch write left items unprocessed")
			}
			if attempt > 0 {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(time.Duration(50<<attempt) * time.Millisecond):
				}
			}
			out, err := s.DB.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{RequestItems: pending})
			if err != nil {
				return err
			}
			pending = out.UnprocessedItems
		}
	}
	return nil
}
